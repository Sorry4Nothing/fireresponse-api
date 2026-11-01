import { and, eq, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { pushToken } from "../db/schema.js";
import { eingabe } from "../eingabe.js";
import type { Person } from "../rechte.js";

// FCM-Registrierungstoken: Buchstaben, Ziffern und _ : . - ohne Klammern, darum fällt die Form «ExponentPushToken[…]» durch
const TOKEN_MUSTER = /^[\w:.-]{20,512}$/;

// Auch in den Importen ohne node:* und process: Die App prüft diese Datei über AppType
export function erstellePushTokenRouten({ db }: { db: Db }) {
  return new Hono<{
    Variables: { person: Person; sitzungId: string };
  }>().put(
    "/",
    eingabe(
      "json",
      z.strictObject({
        token: z.string().regex(TOKEN_MUSTER),
        plattform: z.enum(["ios", "android"]),
      }),
    ),
    async (c) => {
      const person = c.get("person");
      const sitzungId = c.get("sitzungId");
      const { token, plattform } = c.req.valid("json");
      await db.transaction(async (tx) => {
        // Geteiltes Handy: Dasselbe Token einer anderen Sitzung zieht zur aktuellen um
        await tx
          .delete(pushToken)
          .where(
            and(eq(pushToken.token, token), ne(pushToken.sessionId, sitzungId)),
          );
        await tx
          .insert(pushToken)
          .values({ sessionId: sitzungId, token, userId: person.id, plattform })
          .onConflictDoUpdate({
            target: pushToken.sessionId,
            set: { token, plattform, zuletztGesehen: sql`now()` },
          });
      });
      return c.body(null, 204);
    },
  );
}
