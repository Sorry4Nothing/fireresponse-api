import { and, asc, desc, eq, inArray, isNull, lt, max, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../db/client.js";
import {
  einheit,
  einheitRolle,
  infokanalGelesen,
  infokanalMitteilung as m,
  profilbild,
  user,
} from "../db/schema.js";
import { bildUrl } from "../bild.js";
import { eingabe } from "../eingabe.js";
import { pushInfokanal } from "../infokanal.js";
import type { Fcm } from "../push.js";
import {
  darfInfokanalLesen,
  hatRolleIn,
  istKommandoIn,
  type Person,
} from "../rechte.js";

const ZEICHEN_MAX = 2000;
const SEITE_STANDARD = 50;
// Jede neue Mitteilung löst einen Push an die ganze Einheit aus: je Konto höchstens 20 in 10 Minuten
const NEUE_MAX = 20;
const FENSTER_MS = 10 * 60_000;

const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const mitteilungPfad = z.strictObject({ einheitId: z.uuid(), id: z.uuid() });
const seiteSchema = z.strictObject({
  vor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(SEITE_STANDARD),
});
// Nur Text. Zeichen zählen als Unicode-Zeichen wie char_length in der Datenbank; Leerraum an den Enden fällt weg, ein Text ohne Zeichen ist ungültig; das Zeichen NUL lehnt PostgreSQL ab (22021)
const textSchema = z.strictObject({
  text: z
    .string()
    .trim()
    .refine(
      (t) => t.length > 0 && [...t].length <= ZEICHEN_MAX && !t.includes("\0"),
    ),
});

// Auch in den Importen ohne node:* und process: Die App prüft diese Datei über AppType
export function erstelleInfokanalRouten({ db, fcm }: { db: Db; fcm?: Fcm }) {
  // shortcut: Zähler im Arbeitsspeicher, ein Neustart setzt ihn zurück und mehrere Instanzen zählen getrennt; in die Datenbank, sobald die API auf mehr als einer Instanz läuft
  const versuche = new Map<string, number[]>();
  const zuViele = (id: string) => {
    const jetzt = Date.now();
    const liste = (versuche.get(id) ?? []).filter(
      (t) => jetzt - t < FENSTER_MS,
    );
    const voll = liste.length >= NEUE_MAX;
    if (!voll) liste.push(jetzt);
    versuche.set(id, liste);
    return voll;
  };

  // Mitteilungen mit Autor, dessen Rolle genau in der Einheit der Mitteilung und Bild; die Bedingung setzt der Aufrufer
  const mitteilungen = () =>
    db
      .select({
        id: m.id,
        text: m.text,
        erstelltAm: m.erstelltAm,
        bearbeitetAm: m.bearbeitetAm,
        geloeschtAm: m.geloeschtAm,
        autorId: m.autorId,
        autorName: user.name,
        autorRolle: einheitRolle.typ,
        bildUrl,
      })
      .from(m)
      .leftJoin(user, eq(user.id, m.autorId))
      .leftJoin(
        einheitRolle,
        and(
          eq(einheitRolle.userId, m.autorId),
          eq(einheitRolle.einheitId, m.einheitId),
        ),
      )
      .leftJoin(profilbild, eq(profilbild.userId, m.autorId));

  type Zeile = Awaited<ReturnType<typeof mitteilungen>>[number];

  // Die App rendert nur, was darfBearbeiten und darfLoeschen sagen; eine gelöschte Mitteilung trägt weder Text noch Autor
  const ausgabe = (z: Zeile, person: Person, einheitId: string) => {
    const weg = z.geloeschtAm !== null;
    const eigene = z.autorId === person.id;
    return {
      id: z.id,
      text: weg ? null : z.text,
      geloescht: weg,
      bearbeitet: !weg && z.bearbeitetAm !== null,
      erstelltAm: z.erstelltAm,
      autor:
        weg || z.autorId === null
          ? null
          : {
              name: z.autorName ?? "",
              // Stellvertretung zählt als Kommando; wer die Rolle verloren hat, trägt keine
              rolle:
                z.autorRolle === null
                  ? null
                  : z.autorRolle === "leitung"
                    ? "leitung"
                    : "kommando",
              bildUrl: z.bildUrl,
            },
      eigene,
      darfBearbeiten: !weg && eigene && hatRolleIn(person, einheitId),
      darfLoeschen: !weg && (eigene || istKommandoIn(person, einheitId)),
    };
  };

  // Fremde wie unbekannte Einheiten sind 404, erst danach zählt das Recht (403)
  const pruefe = (
    person: Person,
    einheitId: string,
    zweck: "lesen" | "schreiben",
  ) => {
    if (!darfInfokanalLesen(person, einheitId)) throw new HTTPException(404);
    if (zweck === "schreiben" && !hatRolleIn(person, einheitId)) {
      throw new HTTPException(403);
    }
  };

  // Eine noch nicht gelöschte Mitteilung dieser Einheit, sonst 404; die Einheit steht immer in der Bedingung, nie nur die ID der Mitteilung
  async function ladeOffene(einheitId: string, id: string) {
    const [zeile] = await mitteilungen().where(
      and(eq(m.id, id), eq(m.einheitId, einheitId), isNull(m.geloeschtAm)),
    );
    if (!zeile) throw new HTTPException(404);
    return zeile;
  }

  return (
    new Hono<{ Variables: { person: Person } }>()
      // Eine Zeile je Einheit der Person
      .get("/", async (c) => {
        const person = c.get("person");
        const ids = [
          ...new Set([
            ...person.einheiten.map((r) => r.einheitId),
            ...person.teilnehmendeEinheiten,
          ]),
        ];
        const einheiten = await db
          .select({ id: einheit.id, name: einheit.name, typ: einheit.typ })
          .from(einheit)
          .where(inArray(einheit.id, ids))
          .orderBy(asc(einheit.name), asc(einheit.id));
        // Eigene und gelöschte Mitteilungen zählen nicht als ungelesen; ohne Lesestand ist alles ungelesen
        const zahlen = await db
          .select({
            einheitId: m.einheitId,
            ungelesen:
              sql<number>`count(*) filter (where ${m.autorId} is distinct from ${person.id} and ${m.erstelltAm} > coalesce(${infokanalGelesen.gelesenBis}, '-infinity'))`.mapWith(
                Number,
              ),
            letzte: max(m.erstelltAm),
          })
          .from(m)
          .leftJoin(
            infokanalGelesen,
            and(
              eq(infokanalGelesen.einheitId, m.einheitId),
              eq(infokanalGelesen.userId, person.id),
            ),
          )
          .where(and(inArray(m.einheitId, ids), isNull(m.geloeschtAm)))
          .groupBy(m.einheitId);
        const nachEinheit = new Map(zahlen.map((z) => [z.einheitId, z]));
        return c.json({
          infokanaele: einheiten.map((e) => ({
            einheit: { id: e.id, name: e.name, typ: e.typ },
            name: `Infokanal ${e.name}`,
            darfSchreiben: hatRolleIn(person, e.id),
            ungelesen: nachEinheit.get(e.id)?.ungelesen ?? 0,
            letzteMitteilungAm: nachEinheit.get(e.id)?.letzte ?? null,
          })),
        });
      })
      .get(
        "/:einheitId/mitteilungen",
        eingabe("param", einheitPfad),
        eingabe("query", seiteSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId } = c.req.valid("param");
          const { vor, limit } = c.req.valid("query");
          pruefe(person, einheitId, "lesen");
          // Die neueste zuerst; id ist uuidv7 und damit nach Zeit geordnet. Eine mehr holen: Gibt es sie, folgt eine Seite
          const zeilen = await mitteilungen()
            .where(
              and(eq(m.einheitId, einheitId), vor ? lt(m.id, vor) : undefined),
            )
            .orderBy(desc(m.id))
            .limit(limit + 1);
          const seite = zeilen.slice(0, limit);
          return c.json({
            darfSchreiben: hatRolleIn(person, einheitId),
            mitteilungen: seite.map((z) => ausgabe(z, person, einheitId)),
            naechste: zeilen.length > limit ? seite[limit - 1]!.id : null,
          });
        },
      )
      .post(
        "/:einheitId/mitteilungen",
        eingabe("param", einheitPfad),
        eingabe("json", textSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId } = c.req.valid("param");
          const { text } = c.req.valid("json");
          pruefe(person, einheitId, "schreiben");
          if (zuViele(person.id)) throw new HTTPException(429);
          const [neu] = await db
            .insert(m)
            .values({ einheitId, autorId: person.id, text })
            .returning({ id: m.id });
          // Erst nach dem Speichern; wirft nie, ein Fehler hier lässt die Mitteilung bestehen
          await pushInfokanal(
            { db, fcm, c },
            { einheitId, autorId: person.id },
          );
          const [zeile] = await mitteilungen().where(eq(m.id, neu!.id));
          return c.json(ausgabe(zeile!, person, einheitId), 201);
        },
      )
      // Nur die schreibende Person, und nur solange sie Kommando oder Leitung der Einheit ist; ohne Push
      .put(
        "/:einheitId/mitteilungen/:id",
        eingabe("param", mitteilungPfad),
        eingabe("json", textSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId, id } = c.req.valid("param");
          const { text } = c.req.valid("json");
          pruefe(person, einheitId, "lesen");
          const zeile = await ladeOffene(einheitId, id);
          if (zeile.autorId !== person.id || !hatRolleIn(person, einheitId)) {
            throw new HTTPException(403);
          }
          // Die Bedingung gilt noch einmal im Update: Wurde die Mitteilung inzwischen gelöscht, ändert es nichts
          const [geaendert] = await db
            .update(m)
            .set({ text, bearbeitetAm: sql`now()` })
            .where(
              and(
                eq(m.id, id),
                eq(m.einheitId, einheitId),
                eq(m.autorId, person.id),
                isNull(m.geloeschtAm),
              ),
            )
            .returning({ id: m.id });
          if (!geaendert) throw new HTTPException(404);
          const [neu] = await mitteilungen().where(eq(m.id, id));
          return c.json(ausgabe(neu!, person, einheitId));
        },
      )
      // Löscht Text und Autor in der Datenbank; die Zeile bleibt als Platzhalter bis zur automatischen Löschung. Die schreibende Person löscht auch, wenn sie die Rolle verloren hat; fremde Mitteilungen löscht nur das Kommando
      .delete(
        "/:einheitId/mitteilungen/:id",
        eingabe("param", mitteilungPfad),
        async (c) => {
          const person = c.get("person");
          const { einheitId, id } = c.req.valid("param");
          pruefe(person, einheitId, "lesen");
          const zeile = await ladeOffene(einheitId, id);
          if (
            zeile.autorId !== person.id &&
            !istKommandoIn(person, einheitId)
          ) {
            throw new HTTPException(403);
          }
          const [weg] = await db
            .update(m)
            .set({ text: null, autorId: null, geloeschtAm: sql`now()` })
            .where(
              and(
                eq(m.id, id),
                eq(m.einheitId, einheitId),
                isNull(m.geloeschtAm),
              ),
            )
            .returning({ id: m.id });
          if (!weg) throw new HTTPException(404);
          return c.body(null, 204);
        },
      )
      // Der Lesestand gilt für die Einheit, nicht je Mitteilung
      .put("/:einheitId/gelesen", eingabe("param", einheitPfad), async (c) => {
        const person = c.get("person");
        const { einheitId } = c.req.valid("param");
        pruefe(person, einheitId, "lesen");
        await db
          .insert(infokanalGelesen)
          .values({ userId: person.id, einheitId, gelesenBis: sql`now()` })
          .onConflictDoUpdate({
            target: [infokanalGelesen.userId, infokanalGelesen.einheitId],
            set: { gelesenBis: sql`now()` },
          });
        return c.body(null, 204);
      })
  );
}
