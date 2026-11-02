import { asc } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { bezirk } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import { Konflikt } from "../../konflikt.js";
import { protokolliere } from "../../konten.js";
import type { Person } from "../../rechte.js";

const anlegenSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
});

// Bezirke gehören dem Kantonsadmin; sie sind kein Objekt einer Einheit, darum gleich 403
export function erstelleBezirkRouten({ db }: { db: Db }) {
  return new Hono<{ Variables: { person: Person } }>()
    .get("/", async (c) => {
      if (!c.get("person").kantonsadmin) throw new HTTPException(403);
      const bezirke = await db
        .select({ id: bezirk.id, name: bezirk.name })
        .from(bezirk)
        .orderBy(asc(bezirk.name), asc(bezirk.id));
      return c.json({ bezirke });
    })
    .post("/", eingabe("json", anlegenSchema), async (c) => {
      const person = c.get("person");
      if (!person.kantonsadmin) throw new HTTPException(403);
      const { name } = c.req.valid("json");
      const id = await db.transaction(async (tx) => {
        // Der Index ist eindeutig auf lower(name): Ohne Treffer gibt es keine Zeile zurück
        const [neu] = await tx
          .insert(bezirk)
          .values({ name })
          .onConflictDoNothing()
          .returning({ id: bezirk.id });
        if (!neu) throw new Konflikt("BEZIRK_VORHANDEN");
        await protokolliere(tx, {
          einheitId: null,
          akteurId: person.id,
          aktion: "bezirk_angelegt",
          zielTyp: "bezirk",
          zielId: neu.id,
        });
        return neu.id;
      });
      return c.json({ id }, 201);
    });
}
