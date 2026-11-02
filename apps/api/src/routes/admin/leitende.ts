import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { einheitRolle } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import {
  erstelleKontoFabrik,
  neuesKontoSchema,
  protokolliere,
} from "../../konten.js";
import { pruefeEinheit, type Person } from "../../rechte.js";

const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const zielPfad = z.strictObject({ einheitId: z.uuid(), userId: z.uuid() });

// Leitende legen Kommando und Stellvertretungen an (und das Konto des Kantonsadmins). Leitende sind keine Kontakte und haben darum keine Nummer
export function erstelleLeitendeRouten({ db }: { db: Db }) {
  return (
    new Hono<{ Variables: { person: Person } }>()
      .post(
        "/",
        eingabe("param", einheitPfad),
        eingabe("json", neuesKontoSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId } = c.req.valid("param");
          const konto = c.req.valid("json");
          await pruefeEinheit(db, person, einheitId, "verwalten");
          const neu = await db.transaction(async (tx) => {
            const neu = await erstelleKontoFabrik(tx)(konto);
            await tx
              .insert(einheitRolle)
              .values({ userId: neu.id, einheitId, typ: "leitung" });
            await protokolliere(tx, {
              einheitId,
              akteurId: person.id,
              aktion: "person_angelegt",
              zielTyp: "person",
              zielId: neu.id,
              details: { rolle: "leitung" },
            });
            return neu;
          });
          // 201 erst nach dem Commit: Ein zurückgenommenes Startpasswort darf die Antwort nie erreichen
          return c.json(neu, 201);
        },
      )
      // Entfernt nur die Rolle «Leitung»; das Konto bleibt (die Person ist dann ohne Einheit). Kommando und Stellvertretungen gehen über die Übergabe und die Stellvertretungen
      .delete("/:userId", eingabe("param", zielPfad), async (c) => {
        const person = c.get("person");
        const { einheitId, userId } = c.req.valid("param");
        await pruefeEinheit(db, person, einheitId, "verwalten");
        await db.transaction(async (tx) => {
          const entfernt = await tx
            .delete(einheitRolle)
            .where(
              and(
                eq(einheitRolle.einheitId, einheitId),
                eq(einheitRolle.userId, userId),
                eq(einheitRolle.typ, "leitung"),
              ),
            )
            .returning({ userId: einheitRolle.userId });
          if (entfernt.length === 0) throw new HTTPException(404);
          await protokolliere(tx, {
            einheitId,
            akteurId: person.id,
            aktion: "leitung_entfernt",
            zielTyp: "person",
            zielId: userId,
          });
        });
        return c.body(null, 204);
      })
  );
}
