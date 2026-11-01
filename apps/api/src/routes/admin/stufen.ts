import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import {
  auditLog,
  kind,
  programmStufe,
  rolle,
  stufe,
  zeitregel,
} from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import type { Person } from "../../rechte.js";

const name = z.string().trim().min(1).max(100);
const kuerzel = z.string().trim().min(1).max(20);

// Ein Schema pro Route, mit keiner Nicht-Admin-Route geteilt
const anlegenSchema = z.strictObject({ name, kuerzel: kuerzel.optional() });
const aendernSchema = z.strictObject({
  name: name.optional(),
  kuerzel: kuerzel.optional(),
});
// Die SL in der Reihenfolge der Kontakte; wer fehlt, rückt hinter die genannten
const reihenfolgeSchema = z.strictObject({
  ids: z
    .array(z.uuid())
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length),
});
const NAME_VERGEBEN = {
  code: "STUFENNAME_VERGEBEN",
  message: "Es gibt schon eine Stufe mit diesem Namen.",
} as const;

// Postgres meldet die Verletzung des Indexes stufe_name_pro_abteilung; Drizzle legt den Fehler in cause
const istNameVergeben = (fehler: unknown) =>
  (fehler as { cause?: { code?: string } })?.cause?.code === "23505";

const STUFE_BELEGT = {
  code: "STUFE_BELEGT",
  message:
    "Der Stufe sind noch Kinder oder Leitende zugewiesen. Weise sie zuerst einer anderen Stufe zu.",
} as const;

// 23503: Fremdschlüssel verletzt, etwa ein Kind, das gleichzeitig in die Stufe kommt
const istFremdschluessel = (fehler: unknown) =>
  (fehler as { cause?: { code?: string } })?.cause?.code === "23503";

class Belegt extends Error {}

const pfad = () => z.strictObject({ id: z.uuid() });

export function erstelleAdminStufenRouten({ db }: { db: Db }) {
  return new Hono<{ Variables: { person: Person } }>()
    .post("/", eingabe("json", anlegenSchema), async (c) => {
      const person = c.get("person");
      if (!person.admin) throw new HTTPException(403);
      try {
        const [neu] = await db
          .insert(stufe)
          .values({
            // Die Verwaltung fragt kein Kürzel; leer ist erlaubt
            kuerzel: "",
            ...c.req.valid("json"),
            abteilungId: person.abteilungId,
          })
          .returning({ id: stufe.id });
        return c.json({ id: neu.id }, 201);
      } catch (fehler) {
        if (istNameVergeben(fehler)) return c.json(NAME_VERGEBEN, 409);
        throw fehler;
      }
    })
    .patch(
      "/:id",
      eingabe("param", pfad()),
      eingabe("json", aendernSchema),
      async (c) => {
        const person = c.get("person");
        const { id } = c.req.valid("param");
        const felder = c.req.valid("json");
        // In SQL auf die Abteilung gefiltert: fremde wie unbekannte IDs sind 404, erst danach zählt das Recht
        const [ziel] = await db
          .select({ id: stufe.id })
          .from(stufe)
          .where(
            and(eq(stufe.id, id), eq(stufe.abteilungId, person.abteilungId)),
          );
        if (!ziel) throw new HTTPException(404);
        if (!person.admin) throw new HTTPException(403);
        // Ohne Schlüssel wirft Drizzle bei set({}): kein Schreibzugriff
        if (Object.keys(felder).length > 0) {
          try {
            await db.update(stufe).set(felder).where(eq(stufe.id, id));
          } catch (fehler) {
            if (istNameVergeben(fehler)) return c.json(NAME_VERGEBEN, 409);
            throw fehler;
          }
        }
        return c.body(null, 204);
      },
    )
    .put(
      "/:id/stufenleitung",
      eingabe("param", pfad()),
      eingabe("json", reihenfolgeSchema),
      async (c) => {
        const person = c.get("person");
        const { id } = c.req.valid("param");
        const { ids } = c.req.valid("json");
        const [ziel] = await db
          .select({ id: stufe.id })
          .from(stufe)
          .where(
            and(eq(stufe.id, id), eq(stufe.abteilungId, person.abteilungId)),
          );
        if (!ziel) throw new HTTPException(404);
        if (!person.admin) throw new HTTPException(403);
        await db.transaction(async (tx) => {
          const sl = await tx
            .select({ userId: rolle.userId })
            .from(rolle)
            .where(and(eq(rolle.stufeId, id), eq(rolle.typ, "stufenleitung")));
          const vorhanden = new Set(sl.map((z) => z.userId));
          // Nur SL dieser Stufe lassen sich einreihen
          if (!ids.every((userId) => vorhanden.has(userId))) {
            throw new HTTPException(400);
          }
          await tx
            .update(rolle)
            .set({ prioritaet: null })
            .where(and(eq(rolle.stufeId, id), eq(rolle.typ, "stufenleitung")));
          for (const [i, userId] of ids.entries()) {
            await tx
              .update(rolle)
              .set({ prioritaet: i + 1 })
              .where(and(eq(rolle.stufeId, id), eq(rolle.userId, userId)));
          }
          await tx.insert(auditLog).values({
            abteilungId: person.abteilungId,
            akteurId: person.id,
            aktion: "sl_reihenfolge_geaendert",
            zielTyp: "stufe",
            zielId: id,
            details: { anzahl: ids.length },
          });
        });
        return c.body(null, 204);
      },
    )
    .delete("/:id", eingabe("param", pfad()), async (c) => {
      const person = c.get("person");
      const { id } = c.req.valid("param");
      const [ziel] = await db
        .select({ id: stufe.id, name: stufe.name })
        .from(stufe)
        .where(
          and(eq(stufe.id, id), eq(stufe.abteilungId, person.abteilungId)),
        );
      if (!ziel) throw new HTTPException(404);
      if (!person.admin) throw new HTTPException(403);
      try {
        await db.transaction(async (tx) => {
          const [mitKind] = await tx
            .select({ id: kind.id })
            .from(kind)
            .where(eq(kind.stufeId, id))
            .limit(1);
          const [mitRolle] = await tx
            .select({ userId: rolle.userId })
            .from(rolle)
            .where(eq(rolle.stufeId, id))
            .limit(1);
          if (mitKind || mitRolle) throw new Belegt();
          // Alles, was nur an der Stufe hängt
          await tx.delete(programmStufe).where(eq(programmStufe.stufeId, id));
          await tx.delete(zeitregel).where(eq(zeitregel.stufeId, id));
          await tx.delete(stufe).where(eq(stufe.id, id));
          await tx.insert(auditLog).values({
            abteilungId: person.abteilungId,
            akteurId: person.id,
            aktion: "stufe_geloescht",
            zielTyp: "stufe",
            zielId: id,
            details: { name: ziel.name },
          });
        });
      } catch (fehler) {
        if (fehler instanceof Belegt || istFremdschluessel(fehler)) {
          return c.json(STUFE_BELEGT, 409);
        }
        throw fehler;
      }
      return c.body(null, 204);
    });
}
