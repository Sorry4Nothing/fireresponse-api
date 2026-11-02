import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { auditLog, zeitregel } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import { pruefeEinheit, type Person } from "../../rechte.js";

// Wochentag ISO: 1 Montag bis 7 Sonntag; Uhrzeit HH:mm in Schweizer Zeit
const wochentag = z.number().int().min(1).max(7);
const uhrzeit = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
// Der Push-Titel; {Programm} und {Datum} ersetzt der Server (ebenso in der Beschreibung)
const text = z.string().trim().min(1).max(150);
// Der Text unter dem Titel; leer heisst: kein Text
const beschreibung = z.string().trim().min(1).max(300).nullable();

// Ein Schema pro Route, mit keiner Nicht-Admin-Route geteilt
const anlegenSchema = z.strictObject({
  wochentag,
  uhrzeit,
  text,
  beschreibung: beschreibung.optional(),
  aktiv: z.boolean(),
});
const aendernSchema = z.strictObject({
  wochentag: wochentag.optional(),
  uhrzeit: uhrzeit.optional(),
  text: text.optional(),
  beschreibung: beschreibung.optional(),
  aktiv: z.boolean().optional(),
});
// einheitId steht im Pfad der Verwaltung: Sie kommt vom Umschalter, nie aus dem Body
const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const regelPfad = z.strictObject({ einheitId: z.uuid(), id: z.uuid() });

export function erstelleZeitregelRouten({ db }: { db: Db }) {
  // In SQL auf die Einheit gefiltert: Regeln einer anderen Einheit sind 404
  async function ladeZiel(person: Person, einheitId: string, id: string) {
    await pruefeEinheit(db, person, einheitId, "verwalten");
    const [ziel] = await db
      .select({ id: zeitregel.id })
      .from(zeitregel)
      .where(and(eq(zeitregel.id, id), eq(zeitregel.einheitId, einheitId)));
    if (!ziel) throw new HTTPException(404);
  }

  return new Hono<{ Variables: { person: Person } }>()
    .get("/", eingabe("param", einheitPfad), async (c) => {
      const person = c.get("person");
      const { einheitId } = c.req.valid("param");
      await pruefeEinheit(db, person, einheitId, "verwalten");
      const regeln = await db
        .select({
          id: zeitregel.id,
          wochentag: zeitregel.wochentag,
          uhrzeit: zeitregel.uhrzeit,
          text: zeitregel.text,
          beschreibung: zeitregel.beschreibung,
          aktiv: zeitregel.aktiv,
        })
        .from(zeitregel)
        .where(eq(zeitregel.einheitId, einheitId))
        .orderBy(
          asc(zeitregel.wochentag),
          asc(zeitregel.uhrzeit),
          asc(zeitregel.id),
        );
      return c.json({ regeln });
    })
    .post(
      "/",
      eingabe("param", einheitPfad),
      eingabe("json", anlegenSchema),
      async (c) => {
        const person = c.get("person");
        const { einheitId } = c.req.valid("param");
        const felder = c.req.valid("json");
        await pruefeEinheit(db, person, einheitId, "verwalten");
        const neu = await db.transaction(async (tx) => {
          const [zeile] = await tx
            .insert(zeitregel)
            .values({ ...felder, einheitId })
            .returning({ id: zeitregel.id });
          // Ohne den Text: Er läuft in keinen Log
          await tx.insert(auditLog).values({
            einheitId,
            akteurId: person.id,
            aktion: "zeitregel_angelegt",
            zielTyp: "zeitregel",
            zielId: zeile.id,
            details: {
              wochentag: felder.wochentag,
              uhrzeit: felder.uhrzeit,
              aktiv: felder.aktiv,
            },
          });
          return zeile;
        });
        return c.json({ id: neu.id }, 201);
      },
    )
    .patch(
      "/:id",
      eingabe("param", regelPfad),
      eingabe("json", aendernSchema),
      async (c) => {
        const person = c.get("person");
        const { einheitId, id } = c.req.valid("param");
        const felder = c.req.valid("json");
        await ladeZiel(person, einheitId, id);
        // Ohne Schlüssel wirft Drizzle bei set({}): kein Schreibzugriff
        if (Object.keys(felder).length > 0) {
          await db.transaction(async (tx) => {
            await tx.update(zeitregel).set(felder).where(eq(zeitregel.id, id));
            // Welche Felder sich geändert haben, nie der Text
            await tx.insert(auditLog).values({
              einheitId,
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
    .delete("/:id", eingabe("param", regelPfad), async (c) => {
      const person = c.get("person");
      const { einheitId, id } = c.req.valid("param");
      await ladeZiel(person, einheitId, id);
      await db.transaction(async (tx) => {
        await tx.delete(zeitregel).where(eq(zeitregel.id, id));
        await tx.insert(auditLog).values({
          einheitId,
          akteurId: person.id,
          aktion: "zeitregel_geloescht",
          zielTyp: "zeitregel",
          zielId: id,
        });
      });
      return c.body(null, 204);
    });
}
