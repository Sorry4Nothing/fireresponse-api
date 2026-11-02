import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { bezirk } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import { eindeutigkeitsVerstoss, Konflikt } from "../../konflikt.js";
import { protokolliere } from "../../konten.js";
import type { Person } from "../../rechte.js";

const anlegenSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
});

const pfadSchema = z.strictObject({ bezirkId: z.uuid() });

// Drizzle verpackt den Fehler von postgres-js in cause; on delete restrict meldet 23001, ein anderer Fremdschlüssel 23503
function fremdschluesselVerstoss(fehler: unknown): boolean {
  for (let f = fehler as Record<string, unknown> | undefined; f;) {
    if (f.code === "23001" || f.code === "23503") return true;
    f = f.cause as Record<string, unknown> | undefined;
  }
  return false;
}

// Bezirke gehören dem Kantonsadmin; sie sind kein Objekt einer Einheit, darum gleich 403
export function erstelleBezirkRouten({ db }: { db: Db }) {
  return (
    new Hono<{ Variables: { person: Person } }>()
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
      })
      .patch(
        "/:bezirkId",
        eingabe("param", pfadSchema),
        eingabe("json", anlegenSchema),
        async (c) => {
          const person = c.get("person");
          if (!person.kantonsadmin) throw new HTTPException(403);
          const { bezirkId } = c.req.valid("param");
          const { name } = c.req.valid("json");
          await db
            .transaction(async (tx) => {
              const [alt] = await tx
                .select({ name: bezirk.name })
                .from(bezirk)
                .where(eq(bezirk.id, bezirkId))
                .for("update");
              if (!alt) throw new HTTPException(404);
              await tx
                .update(bezirk)
                .set({ name })
                .where(eq(bezirk.id, bezirkId));
              await protokolliere(tx, {
                einheitId: null,
                akteurId: person.id,
                aktion: "bezirk_umbenannt",
                zielTyp: "bezirk",
                zielId: bezirkId,
                details: { von: alt.name, nach: name },
              });
            })
            .catch((fehler) => {
              // Der Index ist eindeutig auf lower(name)
              if (eindeutigkeitsVerstoss(fehler) === "bezirk_name_eindeutig")
                throw new Konflikt("BEZIRK_VORHANDEN");
              throw fehler;
            });
          return c.body(null, 204);
        },
      )
      // Nur ein Bezirk ohne Einheiten: Der Fremdschlüssel steht auf restrict, ein Bezirk mit Einheiten bleibt
      .delete("/:bezirkId", eingabe("param", pfadSchema), async (c) => {
        const person = c.get("person");
        if (!person.kantonsadmin) throw new HTTPException(403);
        const { bezirkId } = c.req.valid("param");
        await db
          .transaction(async (tx) => {
            const [weg] = await tx
              .delete(bezirk)
              .where(eq(bezirk.id, bezirkId))
              .returning({ name: bezirk.name });
            if (!weg) throw new HTTPException(404);
            await protokolliere(tx, {
              einheitId: null,
              akteurId: person.id,
              aktion: "bezirk_geloescht",
              zielTyp: "bezirk",
              zielId: bezirkId,
              details: { name: weg.name },
            });
          })
          .catch((fehler) => {
            if (fremdschluesselVerstoss(fehler))
              throw new Konflikt("BEZIRK_BELEGT");
            throw fehler;
          });
        return c.body(null, 204);
      })
  );
}
