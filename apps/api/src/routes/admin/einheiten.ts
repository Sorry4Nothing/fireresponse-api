import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { user } from "../../db/schema.js";
import { uebergibKommando, UebergabeFehler } from "../../einheiten.js";
import { eingabe } from "../../eingabe.js";
import { aktivesKonto, pruefeEinheit, type Person } from "../../rechte.js";

const pfadSchema = z.strictObject({ einheitId: z.uuid() });
const uebergabeSchema = z.strictObject({
  neuerKommandantId: z.uuid(),
  // Die neue Rolle der bisherigen Kommandantin oder des bisherigen Kommandanten
  bisherigeRolle: z.discriminatedUnion("typ", [
    z.strictObject({
      typ: z.literal("stellvertretung"),
      reihenfolge: z.int().min(1).max(99),
    }),
    z.strictObject({ typ: z.literal("leitung") }),
    z.strictObject({ typ: z.literal("keine") }),
  ]),
});

const KONFLIKT = {
  KEIN_KOMMANDANT: {
    code: "KEIN_KOMMANDANT",
    message: "Die Einheit hat keine Kommandantin und keinen Kommandanten.",
  },
  GLEICHE_PERSON: {
    code: "GLEICHE_PERSON",
    message: "Diese Person ist schon Kommandantin oder Kommandant.",
  },
} as const;

export function erstelleEinheitenRouten({ db }: { db: Db }) {
  return new Hono<{ Variables: { person: Person } }>().post(
    "/:einheitId/kommando",
    eingabe("param", pfadSchema),
    eingabe("json", uebergabeSchema),
    async (c) => {
      const person = c.get("person");
      const { einheitId } = c.req.valid("param");
      const { neuerKommandantId, bisherigeRolle } = c.req.valid("json");
      // Fremde wie unbekannte Einheiten sind 404, erst danach zählt das Recht
      await pruefeEinheit(db, person, einheitId, "lesen");
      if (!person.kantonsadmin) throw new HTTPException(403);
      try {
        await db.transaction(async (tx) => {
          // Aktiv und kein Kantonsadmin-Konto: Es würde das Kommando einer Einheit ohne eigene Rolle führen
          const [ziel] = await tx
            .select({ role: user.role })
            .from(user)
            .where(and(eq(user.id, neuerKommandantId), aktivesKonto()));
          if (!ziel || ziel.role === "admin") throw new HTTPException(400);
          await uebergibKommando(tx, {
            einheitId,
            neuerKommandantId,
            bisherige: bisherigeRolle,
            akteurId: person.id,
          });
        });
      } catch (fehler) {
        if (fehler instanceof UebergabeFehler) {
          return c.json(KONFLIKT[fehler.code], 409);
        }
        throw fehler;
      }
      return c.body(null, 204);
    },
  );
}
