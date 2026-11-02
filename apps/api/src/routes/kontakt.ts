import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { rang } from "../db/schema.js";
import { eingabe } from "../eingabe.js";
import { ladeKontakt } from "../kontakt.js";
import { einheitenFuer, pruefeEinheit, type Person } from "../rechte.js";

const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const rangPfad = z.strictObject({ id: z.uuid() });
const BILD_TYP = { svg: "image/svg+xml", png: "image/png" } as const;

// Eingehängt unter /api/v1
export function erstelleKontaktRouten({ db }: { db: Db }) {
  return (
    new Hono<{ Variables: { person: Person } }>()
      // Der Kontakt der Einheit (Kommandant/in) für die Info-Seite «Konto aufs Kind übertragen»; sichtbar für alle, die die Einheit sehen
      .get(
        "/einheiten/:einheitId/kontakt",
        eingabe("param", einheitPfad),
        async (c) => {
          const person = c.get("person");
          const { einheitId } = c.req.valid("param");
          await pruefeEinheit(db, person, einheitId, "lesen");
          return c.json({ kontakt: await ladeKontakt(db, person, einheitId) });
        },
      )
      // Das eigene Bild eines Rang-Abzeichens; SVG ohne Skripte und ohne Rahmen, PNG wie es ist
      .get("/raenge/:id/abzeichen", eingabe("param", rangPfad), async (c) => {
        const person = c.get("person");
        const { id } = c.req.valid("param");
        c.header("Cache-Control", "private, no-store");
        c.header("Content-Security-Policy", "default-src 'none'; sandbox");
        const einheiten = await einheitenFuer(db, person, "lesen");
        const [zeile] = await db
          .select({ inhalt: rang.abzeichenBild, typ: rang.abzeichenBildTyp })
          .from(rang)
          .where(and(eq(rang.id, id), inArray(rang.einheitId, einheiten)));
        if (!zeile?.inhalt || !zeile.typ || !(zeile.typ in BILD_TYP)) {
          throw new HTTPException(404);
        }
        return c.body(zeile.inhalt as Uint8Array<ArrayBuffer>, 200, {
          "Content-Type": BILD_TYP[zeile.typ as keyof typeof BILD_TYP],
        });
      })
  );
}
