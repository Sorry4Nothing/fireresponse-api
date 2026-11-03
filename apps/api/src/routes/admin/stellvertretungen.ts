import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { einheit, einheitRolle } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import { Konflikt } from "../../konflikt.js";
import {
  erstelleKontoFabrik,
  neuesKontoMitTelefonSchema,
  protokolliere,
  type Tx,
} from "../../konten.js";
import { pruefeEinheit, type Person } from "../../rechte.js";

const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const zielPfad = z.strictObject({ einheitId: z.uuid(), userId: z.uuid() });
const position = z.int().min(1).max(99);
const anlegenSchema = neuesKontoMitTelefonSchema.extend({
  // Ohne Angabe kommt die neue Stellvertretung ans Ende
  reihenfolge: position.optional(),
});
const ordnenSchema = z.strictObject({ reihenfolge: position });

export const sperreStellvertretungen = (tx: Tx, einheitId: string) =>
  // Zeilensperre auf der Einheit, wie bei der Übergabe: Zwei gleichzeitige Änderungen laufen nacheinander
  tx
    .select({ id: einheit.id })
    .from(einheit)
    .where(eq(einheit.id, einheitId))
    .for("no key update");

export const stellvertretungen = (einheitId: string) =>
  and(
    eq(einheitRolle.einheitId, einheitId),
    eq(einheitRolle.typ, "stellvertretung"),
  );

// Stellvertretungen legt, ordnet und entfernt nur das Kommando (und das Konto des Kantonsadmins); für eine Stellvertretung ist «stellvertretungen» 403
export function erstelleStellvertretungsRouten({ db }: { db: Db }) {
  return (
    new Hono<{ Variables: { person: Person } }>()
      .post(
        "/",
        eingabe("param", einheitPfad),
        eingabe("json", anlegenSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId } = c.req.valid("param");
          const { reihenfolge, ...konto } = c.req.valid("json");
          await pruefeEinheit(db, person, einheitId, "stellvertretungen");
          const ergebnis = await db.transaction(async (tx) => {
            await sperreStellvertretungen(tx, einheitId);
            const [{ naechste, belegt }] = await tx
              .select({
                naechste: sql<number>`coalesce(max(${einheitRolle.reihenfolge}), 0) + 1`,
                belegt: sql<boolean>`coalesce(bool_or(${einheitRolle.reihenfolge} = ${reihenfolge ?? 0}), false)`,
              })
              .from(einheitRolle)
              .where(stellvertretungen(einheitId));
            if (belegt) throw new Konflikt("REIHENFOLGE_BELEGT");
            const neu = await erstelleKontoFabrik(tx)(konto);
            const stelle = reihenfolge ?? naechste;
            await tx.insert(einheitRolle).values({
              userId: neu.id,
              einheitId,
              typ: "stellvertretung",
              reihenfolge: stelle,
            });
            await protokolliere(tx, {
              einheitId,
              akteurId: person.id,
              aktion: "person_angelegt",
              zielTyp: "person",
              zielId: neu.id,
              details: { rolle: "stellvertretung", reihenfolge: stelle },
            });
            return { ...neu, reihenfolge: stelle };
          });
          // 201 erst nach dem Commit: Ein zurückgenommenes Startpasswort darf die Antwort nie erreichen
          return c.json(ergebnis, 201);
        },
      )
      .put(
        "/:userId",
        eingabe("param", zielPfad),
        eingabe("json", ordnenSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId, userId } = c.req.valid("param");
          const { reihenfolge } = c.req.valid("json");
          await pruefeEinheit(db, person, einheitId, "stellvertretungen");
          await db.transaction(async (tx) => {
            await sperreStellvertretungen(tx, einheitId);
            const reihe = (
              await tx
                .select({ userId: einheitRolle.userId })
                .from(einheitRolle)
                .where(stellvertretungen(einheitId))
                .orderBy(asc(einheitRolle.reihenfolge))
            ).map((z) => z.userId);
            if (!reihe.includes(userId)) throw new HTTPException(404);
            // Die Person an die gewünschte Stelle setzen, bei zu grosser Zahl ans Ende; alle erhalten danach 1, 2, 3, …
            reihe.splice(reihe.indexOf(userId), 1);
            reihe.splice(reihenfolge - 1, 0, userId);
            // Der UNIQUE-Index ist nicht aufgeschoben: erst alle weit nach hinten, dann an die Stelle
            await tx
              .update(einheitRolle)
              .set({ reihenfolge: sql`${einheitRolle.reihenfolge} + 1000` })
              .where(stellvertretungen(einheitId));
            for (const [i, id] of reihe.entries()) {
              await tx
                .update(einheitRolle)
                .set({ reihenfolge: i + 1 })
                .where(
                  and(
                    stellvertretungen(einheitId),
                    eq(einheitRolle.userId, id),
                  ),
                );
            }
            await protokolliere(tx, {
              einheitId,
              akteurId: person.id,
              aktion: "stellvertretung_geordnet",
              zielTyp: "person",
              zielId: userId,
              details: { reihenfolge: reihe.indexOf(userId) + 1 },
            });
          });
          return c.body(null, 204);
        },
      )
      // Entfernt die Rolle; das Konto bleibt (die Person ist dann ohne Einheit) und löscht sich nicht mit
      .delete("/:userId", eingabe("param", zielPfad), async (c) => {
        const person = c.get("person");
        const { einheitId, userId } = c.req.valid("param");
        await pruefeEinheit(db, person, einheitId, "stellvertretungen");
        await db.transaction(async (tx) => {
          await sperreStellvertretungen(tx, einheitId);
          const entfernt = await tx
            .delete(einheitRolle)
            .where(
              and(
                stellvertretungen(einheitId),
                eq(einheitRolle.userId, userId),
              ),
            )
            .returning({ userId: einheitRolle.userId });
          if (entfernt.length === 0) throw new HTTPException(404);
          await protokolliere(tx, {
            einheitId,
            akteurId: person.id,
            aktion: "stellvertretung_entfernt",
            zielTyp: "person",
            zielId: userId,
          });
        });
        return c.body(null, 204);
      })
  );
}
