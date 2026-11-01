import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { stufe } from "../db/schema.js";
import { eingabe } from "../eingabe.js";
import { kontakteMitTelefon, stufenMitKind } from "../kontakte.js";
import { hatRolle, stufenleitungDerStufen, type Person } from "../rechte.js";

const pfadSchema = z.strictObject({ id: z.uuid() });

export function erstelleStufenRouten({ db }: { db: Db }) {
  return new Hono<{ Variables: { person: Person } }>()
    .get("/", async (c) => {
      const person = c.get("person");
      // Alle mit Sitzung: Stufen tragen keine Personendaten, «Stufen wählen» und die Verwaltung brauchen sie
      const stufen = await db
        .select({
          id: stufe.id,
          name: stufe.name,
          kuerzel: stufe.kuerzel,
        })
        .from(stufe)
        .where(eq(stufe.abteilungId, person.abteilungId))
        .orderBy(asc(stufe.name), asc(stufe.id));
      return c.json({ stufen });
    })
    .get("/:id/kontakte", eingabe("param", pfadSchema), async (c) => {
      const person = c.get("person");
      const { id } = c.req.valid("param");
      // Antworten mit Nummern gehören nie in einen Cache
      c.header("Cache-Control", "no-store");
      const [zeile] = await db
        .select({ id: stufe.id })
        .from(stufe)
        .where(
          and(eq(stufe.id, id), eq(stufe.abteilungId, person.abteilungId)),
        );
      // Fremde Stufen bleiben verborgen: Wer weder Admin noch Leitung noch Elternteil der Stufe ist, bekommt 404
      if (
        !zeile ||
        !(
          person.admin ||
          hatRolle(person, id, "leitung") ||
          (await stufenMitKind(db, person, [id])).has(id)
        )
      ) {
        throw new HTTPException(404);
      }
      const sl = await stufenleitungDerStufen(db, person.abteilungId, [id]);
      return c.json({ kontakte: await kontakteMitTelefon(db, person, sl) });
    });
}
