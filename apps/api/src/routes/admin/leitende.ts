import { Hono } from "hono";
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

// Leitende legen Kommando und Stellvertretungen an (und das Konto des Kantonsadmins). Leitende sind keine Kontakte und haben darum keine Nummer
export function erstelleLeitendeRouten({ db }: { db: Db }) {
  return new Hono<{ Variables: { person: Person } }>().post(
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
  );
}
