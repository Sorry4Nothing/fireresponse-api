import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { auditLog, programm } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import { pruefeEinheit, programmBeginn, type Person } from "../../rechte.js";

// PostgreSQL 18 lehnt das Jahr 0000 ab (Fehler 22008), zod lässt es durch
const tag = z.iso.date().refine((wert) => !wert.startsWith("0000"));
const fensterSchema = z.strictObject({ von: tag, bis: tag });
const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const terminPfad = z.strictObject({ einheitId: z.uuid(), id: z.uuid() });
const aendernSchema = z.strictObject({ nurLeitende: z.boolean() });

// Die Termine einer Einheit für die Verwaltung. Titel, Zeit und Art gehören dem Lodur-Sync und sind hier nur zu sehen; der Schalter «nur Leitende» gehört der Verwaltung, der Sync überschreibt ihn nie
export function erstelleTermineRouten({ db }: { db: Db }) {
  return new Hono<{ Variables: { person: Person } }>()
    .get(
      "/",
      eingabe("param", einheitPfad),
      eingabe("query", fensterSchema),
      async (c) => {
        const { einheitId } = c.req.valid("param");
        const { von, bis } = c.req.valid("query");
        await pruefeEinheit(db, c.get("person"), einheitId, "verwalten");
        const termine = await db
          .select({
            id: programm.id,
            titel: programm.titel,
            art: programm.art,
            status: programm.status,
            ganztaegig: programm.ganztaegig,
            beginn: programm.beginn,
            ende: programm.ende,
            tagVon: programm.tagVon,
            tagBis: programm.tagBis,
            nurLeitende: programm.nurLeitende,
          })
          .from(programm)
          .where(
            and(
              eq(programm.einheitId, einheitId),
              // Inklusive Schweizer Kalendertage: Ein Lager zählt an jedem seiner Tage
              sql`coalesce(programm.tag_bis, (programm.ende at time zone 'Europe/Zurich')::date) >= ${von}`,
              sql`coalesce(programm.tag_von, (programm.beginn at time zone 'Europe/Zurich')::date) <= ${bis}`,
            ),
          )
          .orderBy(programmBeginn, programm.id);
        return c.json({ termine });
      },
    )
    .put(
      "/:id",
      eingabe("param", terminPfad),
      eingabe("json", aendernSchema),
      async (c) => {
        const person = c.get("person");
        const { einheitId, id } = c.req.valid("param");
        const { nurLeitende } = c.req.valid("json");
        await pruefeEinheit(db, person, einheitId, "verwalten");
        await db.transaction(async (tx) => {
          // In SQL auf die Einheit gefiltert: Termine einer anderen Einheit sind 404
          const [alt] = await tx
            .select({ nurLeitende: programm.nurLeitende })
            .from(programm)
            .where(and(eq(programm.id, id), eq(programm.einheitId, einheitId)))
            .for("update");
          if (!alt) throw new HTTPException(404);
          if (alt.nurLeitende === nurLeitende) return;
          await tx
            .update(programm)
            .set({ nurLeitende })
            .where(eq(programm.id, id));
          await tx.insert(auditLog).values({
            einheitId,
            akteurId: person.id,
            aktion: "termin_sichtbarkeit_geaendert",
            zielTyp: "programm",
            zielId: id,
            details: { nurLeitende },
          });
        });
        return c.json({ id, nurLeitende });
      },
    );
}
