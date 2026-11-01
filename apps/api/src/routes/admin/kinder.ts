import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { auditLog, kind, kindEltern, stufe, user } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import type { Person } from "../../rechte.js";

const text = z.string().trim().min(1).max(100);
const elternFeld = z
  .array(z.uuid())
  .max(10)
  .refine((ids) => new Set(ids).size === ids.length);

// Ein Schema pro Route, mit keiner Nicht-Admin-Route geteilt
const anlegenSchema = z.strictObject({
  vorname: text,
  nachname: text,
  stufeId: z.uuid(),
});
const aendernSchema = z.strictObject({
  vorname: text.optional(),
  nachname: text.optional(),
  stufeId: z.uuid().optional(),
  aktiv: z.boolean().optional(),
  eltern: elternFeld.optional(),
});
const pfad = () => z.strictObject({ id: z.uuid() });

type Tx = Pick<Db, "select" | "insert">;

export function erstelleKinderRouten({ db }: { db: Db }) {
  // In SQL auf die Abteilung der Sitzung gefiltert: fremde wie unbekannte IDs sind 404, erst danach zählt das Recht
  async function ladeZiel(person: Person, id: string) {
    const [ziel] = await db
      .select({ stufeId: kind.stufeId, inaktivSeit: kind.inaktivSeit })
      .from(kind)
      .where(and(eq(kind.id, id), eq(kind.abteilungId, person.abteilungId)));
    if (!ziel) throw new HTTPException(404);
    if (!person.admin) throw new HTTPException(403);
    return ziel;
  }

  // Eine fremde oder unbekannte Stufe ist eine ungültige Eingabe, vor jedem Schreibzugriff geprüft
  async function pruefeStufe(person: Person, stufeId: string) {
    const [eigene] = await db
      .select({ id: stufe.id })
      .from(stufe)
      .where(
        and(eq(stufe.id, stufeId), eq(stufe.abteilungId, person.abteilungId)),
      );
    if (!eigene) throw new HTTPException(400);
  }

  async function pruefeEltern(person: Person, eltern: readonly string[]) {
    if (eltern.length === 0) return;
    const eigene = await db
      .select({ id: user.id })
      .from(user)
      .where(
        and(
          inArray(user.id, [...eltern]),
          eq(user.abteilungId, person.abteilungId),
        ),
      );
    if (eigene.length !== eltern.length) throw new HTTPException(400);
  }

  // Jede Rollenänderung wird protokolliert (#22): ein Eintrag je Elternteil mit dessen neuer Kinderliste, ohne Namen
  async function protokolliere(
    tx: Tx,
    person: Person,
    elternIds: readonly string[],
  ) {
    if (elternIds.length === 0) return;
    const links = await tx
      .select({ userId: kindEltern.userId, kindId: kindEltern.kindId })
      .from(kindEltern)
      .where(inArray(kindEltern.userId, [...elternIds]))
      .orderBy(asc(kindEltern.kindId));
    await tx.insert(auditLog).values(
      elternIds.map((userId) => ({
        abteilungId: person.abteilungId,
        akteurId: person.id,
        aktion: "rolle_geaendert",
        zielTyp: "person",
        zielId: userId,
        details: {
          elternteilVon: links
            .filter((l) => l.userId === userId)
            .map((l) => l.kindId),
        },
      })),
    );
  }

  return new Hono<{ Variables: { person: Person } }>()
    .get("/", async (c) => {
      const person = c.get("person");
      if (!person.admin) throw new HTTPException(403);
      const abteilungId = person.abteilungId;
      const [kinder, links] = await Promise.all([
        db
          .select({
            id: kind.id,
            vorname: kind.vorname,
            nachname: kind.nachname,
            stufeId: kind.stufeId,
            inaktivSeit: kind.inaktivSeit,
          })
          .from(kind)
          .where(eq(kind.abteilungId, abteilungId))
          .orderBy(asc(kind.nachname), asc(kind.vorname), asc(kind.id)),
        db
          .select({ kindId: kindEltern.kindId, userId: kindEltern.userId })
          .from(kindEltern)
          .innerJoin(
            kind,
            and(
              eq(kindEltern.kindId, kind.id),
              eq(kind.abteilungId, abteilungId),
            ),
          )
          .innerJoin(
            user,
            and(
              eq(kindEltern.userId, user.id),
              eq(user.abteilungId, abteilungId),
            ),
          )
          .orderBy(asc(kindEltern.userId)),
      ]);
      // Keine Daten: Die Datumsfelder liest #48 in SQL
      return c.json({
        kinder: kinder.map((k) => ({
          id: k.id,
          vorname: k.vorname,
          nachname: k.nachname,
          stufeId: k.stufeId,
          aktiv: k.inaktivSeit === null,
          eltern: links.filter((l) => l.kindId === k.id).map((l) => l.userId),
        })),
      });
    })
    .post("/", eingabe("json", anlegenSchema), async (c) => {
      const person = c.get("person");
      if (!person.admin) throw new HTTPException(403);
      const eingaben = c.req.valid("json");
      await pruefeStufe(person, eingaben.stufeId);
      const [neu] = await db
        .insert(kind)
        .values({ ...eingaben, abteilungId: person.abteilungId })
        .returning({ id: kind.id });
      return c.json({ id: neu.id }, 201);
    })
    .patch(
      "/:id",
      eingabe("param", pfad()),
      eingabe("json", aendernSchema),
      async (c) => {
        const person = c.get("person");
        const { id } = c.req.valid("param");
        const { aktiv, eltern, ...aenderung } = c.req.valid("json");
        const bisher = await ladeZiel(person, id);
        if (aenderung.stufeId !== undefined) {
          await pruefeStufe(person, aenderung.stufeId);
        }
        if (eltern) await pruefeEltern(person, eltern);
        await db.transaction(async (tx) => {
          // Die App schickt das ganze Formular: Nur echte Änderungen setzen die Zeitpunkte
          const felder: Partial<typeof aenderung> & {
            stufeSeit?: SQL;
            inaktivSeit?: SQL | null;
          } = { ...aenderung };
          if (aenderung.stufeId === bisher.stufeId) {
            delete felder.stufeId;
          } else if (aenderung.stufeId !== undefined) {
            felder.stufeSeit = sql`now()`;
          }
          if (aktiv === false && bisher.inaktivSeit === null) {
            felder.inaktivSeit = sql`now()`;
          } else if (aktiv === true && bisher.inaktivSeit !== null) {
            felder.inaktivSeit = null;
          }
          // Ohne Schlüssel wirft Drizzle bei set({}): kein Schreibzugriff
          if (Object.keys(felder).length > 0) {
            await tx.update(kind).set(felder).where(eq(kind.id, id));
          }
          if (eltern) {
            const vorhanden = (
              await tx
                .select({ userId: kindEltern.userId })
                .from(kindEltern)
                .where(eq(kindEltern.kindId, id))
            ).map((zeile) => zeile.userId);
            const weg = vorhanden.filter((u) => !eltern.includes(u));
            // Nur die Differenz: Unveränderte Zeilen behalten erstellt_am
            const neu = eltern.filter((u) => !vorhanden.includes(u));
            if (weg.length > 0) {
              await tx
                .delete(kindEltern)
                .where(
                  and(
                    eq(kindEltern.kindId, id),
                    inArray(kindEltern.userId, weg),
                  ),
                );
            }
            if (neu.length > 0) {
              await tx
                .insert(kindEltern)
                .values(neu.map((userId) => ({ kindId: id, userId })))
                .onConflictDoNothing();
            }
            await protokolliere(tx, person, [...weg, ...neu]);
          }
        });
        return c.body(null, 204);
      },
    )
    .delete("/:id", eingabe("param", pfad()), async (c) => {
      const person = c.get("person");
      const { id } = c.req.valid("param");
      await ladeZiel(person, id);
      await db.transaction(async (tx) => {
        // Vor dem Löschen lesen: kind_eltern verschwindet per CASCADE
        const eltern = (
          await tx
            .select({ userId: kindEltern.userId })
            .from(kindEltern)
            .where(eq(kindEltern.kindId, id))
        ).map((zeile) => zeile.userId);
        await tx.delete(kind).where(eq(kind.id, id));
        await protokolliere(tx, person, eltern);
      });
      return c.body(null, 204);
    });
}
