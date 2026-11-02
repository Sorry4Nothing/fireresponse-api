import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { einheit } from "../db/schema.js";
import { eingabe } from "../eingabe.js";
import type { Person } from "../rechte.js";

const pfadSchema = z.strictObject({ einheitId: z.uuid() });

// Das Logo sehen alle, die zur Einheit gehören (Rolle, Eltern, Teilnehmende) und das Kantonsadmin-Konto. Alle anderen bekommen wie bei einer unbekannten Einheit 404
export function erstelleLogoRouten({ db }: { db: Db }) {
  return new Hono<{ Variables: { person: Person } }>().get(
    "/einheiten/:einheitId/logo",
    eingabe("param", pfadSchema),
    async (c) => {
      const person = c.get("person");
      const { einheitId } = c.req.valid("param");
      const darf =
        person.kantonsadmin ||
        person.einheiten.some((r) => r.einheitId === einheitId) ||
        person.teilnehmendeEinheiten.includes(einheitId);
      const [zeile] = darf
        ? await db
            .select({ typ: einheit.logoBildTyp, bild: einheit.logoBild })
            .from(einheit)
            .where(eq(einheit.id, einheitId))
        : [];
      if (!zeile?.bild || !zeile.typ) throw new HTTPException(404);
      // Selbst ein bereinigtes SVG läuft hier nie als Seite: kein Skript, kein Fremdinhalt, nosniff, in einem Rahmen ohne Rechte. ?v= in der Adresse ändert sich mit dem Bild
      return c.body(zeile.bild as Uint8Array<ArrayBuffer>, 200, {
        "Content-Type": zeile.typ === "svg" ? "image/svg+xml" : "image/png",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-cache",
      });
    },
  );
}
