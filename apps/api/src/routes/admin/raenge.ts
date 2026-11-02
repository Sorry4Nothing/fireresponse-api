import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { adminAbzeichen } from "../../rang-anzeige.js";
import { einheitRolle, rang, teilnehmende } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import { pruefeEinheit, type Person } from "../../rechte.js";

const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const rangPfad = z.strictObject({ einheitId: z.uuid(), rangId: z.uuid() });

// Ränge gehören einer Einheit und sind fest: Die Verwaltung liest sie nur. Anlegen, Ändern, Ordnen und Löschen gibt es nur im Backend (Einheit anlegen, Migration). Die Abzeichen liegen als bereinigte Bytes in der Datenbank
export function erstelleRangRouten({ db }: { db: Db }) {
  async function zeigeRang(einheitId: string, rangId: string) {
    const [zeile] = await db
      .select({
        id: rang.id,
        typ: rang.abzeichenBildTyp,
        bild: rang.abzeichenBild,
      })
      .from(rang)
      .where(and(eq(rang.id, rangId), eq(rang.einheitId, einheitId)));
    if (!zeile) throw new HTTPException(404);
    return zeile;
  }

  return new Hono<{ Variables: { person: Person } }>()
    .get("/", eingabe("param", einheitPfad), async (c) => {
      const person = c.get("person");
      const { einheitId } = c.req.valid("param");
      await pruefeEinheit(db, person, einheitId, "verwalten");
      const raenge = await db
        .select({
          id: rang.id,
          name: rang.name,
          kuerzel: rang.kuerzel,
          typ: rang.typ,
          reihenfolge: rang.reihenfolge,
          sterne: rang.abzeichenSterne,
          bildTyp: rang.abzeichenBildTyp,
          // Ändert sich mit dem Bild: Die Verwaltung hängt es an die Adresse
          bildStand: sql<string | null>`left(md5(${rang.abzeichenBild}), 8)`,
          teilnehmende: sql<number>`(select count(*) from ${teilnehmende} where ${teilnehmende.rangId} = ${rang.id})::int`,
          rollen: sql<number>`(select count(*) from ${einheitRolle} where ${einheitRolle.rangId} = ${rang.id})::int`,
        })
        .from(rang)
        .where(eq(rang.einheitId, einheitId))
        .orderBy(asc(rang.reihenfolge));
      return c.json({
        raenge: raenge.map((r) => ({
          id: r.id,
          name: r.name,
          kuerzel: r.kuerzel,
          typ: r.typ,
          reihenfolge: r.reihenfolge,
          abzeichen: adminAbzeichen({ ...r, einheitId }),
          teilnehmende: r.teilnehmende,
          rollen: r.rollen,
        })),
      });
    })
    .get("/:rangId/abzeichen", eingabe("param", rangPfad), async (c) => {
      const person = c.get("person");
      const { einheitId, rangId } = c.req.valid("param");
      await pruefeEinheit(db, person, einheitId, "verwalten");
      const zeile = await zeigeRang(einheitId, rangId);
      if (!zeile.bild || !zeile.typ) throw new HTTPException(404);
      // Selbst ein bereinigtes SVG läuft hier nie als Seite: kein Skript, kein Fremdinhalt, nosniff, in einem Rahmen ohne Rechte
      return c.body(zeile.bild as Uint8Array<ArrayBuffer>, 200, {
        "Content-Type": zeile.typ === "svg" ? "image/svg+xml" : "image/png",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-cache",
      });
    });
}
