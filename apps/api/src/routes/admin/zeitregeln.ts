import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { auditLog, stufe, zeitregel } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import type { Person } from "../../rechte.js";

// Wochentag ISO: 1 Montag bis 7 Sonntag; Uhrzeit HH:mm in Schweizer Zeit
const wochentag = z.number().int().min(1).max(7);
const uhrzeit = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
// Der Push-Titel; {Programm} und {Datum} ersetzt der Server (ebenso in der Beschreibung)
const text = z.string().trim().min(1).max(150);
// Der Text unter dem Titel; leer heisst: kein Text
const beschreibung = z.string().trim().min(1).max(300).nullable();

// Ein Schema pro Route, mit keiner Nicht-Admin-Route geteilt
const anlegenSchema = z.strictObject({
  stufeId: z.uuid().nullable(),
  wochentag,
  uhrzeit,
  text,
  beschreibung: beschreibung.optional(),
  aktiv: z.boolean(),
});
const aendernSchema = z.strictObject({
  stufeId: z.uuid().nullable().optional(),
  wochentag: wochentag.optional(),
  uhrzeit: uhrzeit.optional(),
  text: text.optional(),
  beschreibung: beschreibung.optional(),
  aktiv: z.boolean().optional(),
});
const pfad = () => z.strictObject({ id: z.uuid() });

export function erstelleZeitregelRouten({ db }: { db: Db }) {
  // Eine fremde oder unbekannte Stufe ist eine ungültige Eingabe, vor jedem Schreibzugriff geprüft
  async function pruefeStufe(person: Person, stufeId: string | null) {
    if (stufeId === null) return;
    const [eigene] = await db
      .select({ id: stufe.id })
      .from(stufe)
      .where(
        and(eq(stufe.id, stufeId), eq(stufe.abteilungId, person.abteilungId)),
      );
    if (!eigene) throw new HTTPException(400);
  }

  // In SQL auf die Abteilung der Sitzung gefiltert: fremde wie unbekannte IDs sind 404, erst danach zählt das Recht
  async function ladeZiel(person: Person, id: string) {
    const [ziel] = await db
      .select({ id: zeitregel.id })
      .from(zeitregel)
      .where(
        and(
          eq(zeitregel.id, id),
          eq(zeitregel.abteilungId, person.abteilungId),
        ),
      );
    if (!ziel) throw new HTTPException(404);
    if (!person.admin) throw new HTTPException(403);
  }

  return new Hono<{ Variables: { person: Person } }>()
    .get("/", async (c) => {
      const person = c.get("person");
      if (!person.admin) throw new HTTPException(403);
      const regeln = await db
        .select({
          id: zeitregel.id,
          stufeId: zeitregel.stufeId,
          wochentag: zeitregel.wochentag,
          uhrzeit: zeitregel.uhrzeit,
          text: zeitregel.text,
          beschreibung: zeitregel.beschreibung,
          aktiv: zeitregel.aktiv,
        })
        .from(zeitregel)
        .where(eq(zeitregel.abteilungId, person.abteilungId))
        .orderBy(
          asc(zeitregel.wochentag),
          asc(zeitregel.uhrzeit),
          asc(zeitregel.id),
        );
      return c.json({ regeln });
    })
    .post("/", eingabe("json", anlegenSchema), async (c) => {
      const person = c.get("person");
      if (!person.admin) throw new HTTPException(403);
      const felder = c.req.valid("json");
      await pruefeStufe(person, felder.stufeId);
      const neu = await db.transaction(async (tx) => {
        const [zeile] = await tx
          .insert(zeitregel)
          .values({ ...felder, abteilungId: person.abteilungId })
          .returning({ id: zeitregel.id });
        // Ohne den Text: Er läuft in keinen Log
        await tx.insert(auditLog).values({
          abteilungId: person.abteilungId,
          akteurId: person.id,
          aktion: "zeitregel_angelegt",
          zielTyp: "zeitregel",
          zielId: zeile.id,
          details: {
            stufeId: felder.stufeId,
            wochentag: felder.wochentag,
            uhrzeit: felder.uhrzeit,
            aktiv: felder.aktiv,
          },
        });
        return zeile;
      });
      return c.json({ id: neu.id }, 201);
    })
    .patch(
      "/:id",
      eingabe("param", pfad()),
      eingabe("json", aendernSchema),
      async (c) => {
        const person = c.get("person");
        const { id } = c.req.valid("param");
        const felder = c.req.valid("json");
        await ladeZiel(person, id);
        if (felder.stufeId !== undefined) {
          await pruefeStufe(person, felder.stufeId);
        }
        // Ohne Schlüssel wirft Drizzle bei set({}): kein Schreibzugriff
        if (Object.keys(felder).length > 0) {
          await db.transaction(async (tx) => {
            await tx.update(zeitregel).set(felder).where(eq(zeitregel.id, id));
            // Welche Felder sich geändert haben, nie der Text
            await tx.insert(auditLog).values({
              abteilungId: person.abteilungId,
              akteurId: person.id,
              aktion: "zeitregel_geaendert",
              zielTyp: "zeitregel",
              zielId: id,
              details: {
                ...felder,
                text: undefined,
                beschreibung: undefined,
                textGeaendert:
                  felder.text !== undefined ||
                  felder.beschreibung !== undefined,
              },
            });
          });
        }
        return c.body(null, 204);
      },
    )
    .delete("/:id", eingabe("param", pfad()), async (c) => {
      const person = c.get("person");
      const { id } = c.req.valid("param");
      await ladeZiel(person, id);
      await db.transaction(async (tx) => {
        await tx.delete(zeitregel).where(eq(zeitregel.id, id));
        await tx.insert(auditLog).values({
          abteilungId: person.abteilungId,
          akteurId: person.id,
          aktion: "zeitregel_geloescht",
          zielTyp: "zeitregel",
          zielId: id,
        });
      });
      return c.body(null, 204);
    });
}
