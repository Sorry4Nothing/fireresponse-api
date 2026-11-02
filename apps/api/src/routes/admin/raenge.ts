import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  ABZEICHEN_MAX_BYTES,
  AbzeichenFehler,
  pruefeAbzeichen,
} from "../../abzeichen.js";
import type { Db } from "../../db/client.js";
import { adminAbzeichen } from "../../rang-anzeige.js";
import { einheit, einheitRolle, rang, teilnehmende } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import { eindeutigkeitsVerstoss, Konflikt } from "../../konflikt.js";
import { protokolliere } from "../../konten.js";
import { pruefeEinheit, type Person } from "../../rechte.js";

const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const rangPfad = z.strictObject({ einheitId: z.uuid(), rangId: z.uuid() });
const name = z.string().trim().min(1).max(100);
const kuerzel = z.string().trim().min(1).max(20);
const reihenfolge = z.int().min(1).max(999);
const sterne = z.int().min(0).max(2);
const typ = z.enum(["kf", "jf", "miliz"]);
const aendernSchema = z
  .strictObject({
    name,
    kuerzel,
    typ,
    reihenfolge,
    abzeichenSterne: sterne.nullable(),
  })
  .partial()
  .refine((b) => Object.values(b).some((wert) => wert !== undefined));
const ordnenSchema = z.strictObject({
  ids: z
    .array(z.uuid())
    .min(1)
    .max(99)
    .refine((ids) => new Set(ids).size === ids.length),
});
const loeschenSchema = z.strictObject({ verschiebenNach: z.uuid().optional() });

const ABZEICHEN_UNGUELTIG = "ABZEICHEN_UNGUELTIG";

// Ränge gehören einer Einheit; die Standard-Ränge legt nur das Backend an (Einheit anlegen, Migration), ändern, ordnen und löschen dürfen Kommando, Stellvertretungen und der Kantonsadmin. Die Abzeichen liegen als bereinigte Bytes in der Datenbank
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

  // Zwei gleichzeitige Anfragen mit derselben Reihenfolge: Die zweite scheitert am Index
  async function mitReihenfolgeKonflikt<T>(aktion: () => Promise<T>) {
    try {
      return await aktion();
    } catch (fehler) {
      if (eindeutigkeitsVerstoss(fehler) === "rang_reihenfolge_pro_einheit") {
        throw new Konflikt("RANG_REIHENFOLGE_BELEGT");
      }
      throw fehler;
    }
  }

  return (
    new Hono<{ Variables: { person: Person } }>()
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
      // Zuerst die neue Reihenfolge aller Ränge eines Typs in einem Schritt (jeder Typ hat seine eigene Hierarchie): Die Pfeile der Verwaltung tauschen so zwei Nachbarn, ohne dass die Einzelwerte kollidieren
      .put(
        "/reihenfolge",
        eingabe("param", einheitPfad),
        eingabe("json", ordnenSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId } = c.req.valid("param");
          const { ids } = c.req.valid("json");
          await pruefeEinheit(db, person, einheitId, "verwalten");
          await db.transaction(async (tx) => {
            await tx
              .select({ id: einheit.id })
              .from(einheit)
              .where(eq(einheit.id, einheitId))
              .for("no key update");
            const alle = await tx
              .select({
                id: rang.id,
                typ: rang.typ,
                reihenfolge: rang.reihenfolge,
              })
              .from(rang)
              .where(eq(rang.einheitId, einheitId));
            const vorhanden = alle.filter(
              (r) => r.typ === alle.find((a) => a.id === ids[0])?.typ,
            );
            // Genau die Ränge dieses Typs in der Einheit, keiner fehlt und keiner ist fremd
            if (
              vorhanden.length !== ids.length ||
              !vorhanden.every((r) => ids.includes(r.id))
            ) {
              throw new HTTPException(400);
            }
            const ziele = ids.map((_, i) => (i + 1) * 10);
            // Der Index ist nicht aufgeschoben und die Werte bleiben in 1 bis 999: erst jeden Rang auf einen freien Zwischenwert, dann an die Stelle
            const belegt = new Set([
              ...vorhanden.map((r) => r.reihenfolge),
              ...ziele,
            ]);
            const zwischen: number[] = [];
            for (let w = 1; zwischen.length < ids.length && w <= 999; w++) {
              if (!belegt.has(w)) zwischen.push(w);
            }
            for (const [i, id] of ids.entries()) {
              await tx
                .update(rang)
                .set({ reihenfolge: zwischen[i] })
                .where(eq(rang.id, id));
            }
            for (const [i, id] of ids.entries()) {
              await tx
                .update(rang)
                .set({ reihenfolge: ziele[i] })
                .where(eq(rang.id, id));
            }
            await protokolliere(tx, {
              einheitId,
              akteurId: person.id,
              aktion: "raenge_geordnet",
              zielTyp: "einheit",
              zielId: einheitId,
            });
          });
          return c.body(null, 204);
        },
      )
      .patch(
        "/:rangId",
        eingabe("param", rangPfad),
        eingabe("json", aendernSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId, rangId } = c.req.valid("param");
          const felder = c.req.valid("json");
          await pruefeEinheit(db, person, einheitId, "verwalten");
          await zeigeRang(einheitId, rangId);
          await mitReihenfolgeKonflikt(() =>
            db.transaction(async (tx) => {
              await tx
                .update(rang)
                .set({
                  ...felder,
                  // Sterne und eigenes Bild schliessen sich aus
                  ...(felder.abzeichenSterne !== undefined && {
                    abzeichenSterne: felder.abzeichenSterne,
                    ...(felder.abzeichenSterne !== null && {
                      abzeichenBild: null,
                      abzeichenBildTyp: null,
                    }),
                  }),
                })
                .where(and(eq(rang.id, rangId), eq(rang.einheitId, einheitId)));
              // Welche Felder, nie die Werte
              await protokolliere(tx, {
                einheitId,
                akteurId: person.id,
                aktion: "rang_geaendert",
                zielTyp: "rang",
                zielId: rangId,
                details: { felder: Object.keys(felder) },
              });
            }),
          );
          return c.body(null, 204);
        },
      )
      // Verschiebt die Personen mit diesem Rang (Teilnehmende, Kommando, Stellvertretungen und Leitende) in einen anderen Rang der Einheit und löscht den Rang. Ohne Ziel scheitert es, solange der Rang zugeteilt ist
      .delete(
        "/:rangId",
        eingabe("param", rangPfad),
        eingabe("query", loeschenSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId, rangId } = c.req.valid("param");
          const { verschiebenNach } = c.req.valid("query");
          await pruefeEinheit(db, person, einheitId, "verwalten");
          await zeigeRang(einheitId, rangId);
          await db.transaction(async (tx) => {
            if (verschiebenNach !== undefined) {
              const [ziel] = await tx
                .select({ id: rang.id })
                .from(rang)
                .where(
                  and(
                    eq(rang.id, verschiebenNach),
                    eq(rang.einheitId, einheitId),
                    ne(rang.id, rangId),
                  ),
                );
              if (!ziel) throw new HTTPException(400);
              await tx
                .update(teilnehmende)
                .set({ rangId: verschiebenNach })
                .where(eq(teilnehmende.rangId, rangId));
              await tx
                .update(einheitRolle)
                .set({ rangId: verschiebenNach })
                .where(eq(einheitRolle.rangId, rangId));
            } else {
              const [{ personen }] = await tx
                .select({ personen: count() })
                .from(teilnehmende)
                .where(eq(teilnehmende.rangId, rangId));
              const [{ rollen }] = await tx
                .select({ rollen: count() })
                .from(einheitRolle)
                .where(eq(einheitRolle.rangId, rangId));
              if (personen + rollen > 0)
                throw new Konflikt("RANG_IN_VERWENDUNG");
            }
            await tx.delete(rang).where(eq(rang.id, rangId));
            await protokolliere(tx, {
              einheitId,
              akteurId: person.id,
              aktion: "rang_geloescht",
              zielTyp: "rang",
              zielId: rangId,
              details: { verschoben: verschiebenNach !== undefined },
            });
          });
          return c.body(null, 204);
        },
      )
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
      })
      // Der Body ist das Bild selbst (SVG oder PNG, höchstens 500 KB); der Typ ergibt sich aus den Bytes. Gespeichert wird das bereinigte Ergebnis, nie die Eingabe
      .put(
        "/:rangId/abzeichen",
        bodyLimit({ maxSize: ABZEICHEN_MAX_BYTES }),
        eingabe("param", rangPfad),
        async (c) => {
          const person = c.get("person");
          const { einheitId, rangId } = c.req.valid("param");
          await pruefeEinheit(db, person, einheitId, "verwalten");
          await zeigeRang(einheitId, rangId);
          let bild;
          try {
            bild = pruefeAbzeichen(new Uint8Array(await c.req.arrayBuffer()));
          } catch (fehler) {
            if (fehler instanceof AbzeichenFehler) {
              return c.json(
                { code: ABZEICHEN_UNGUELTIG, message: fehler.message },
                415,
              );
            }
            throw fehler;
          }
          await db.transaction(async (tx) => {
            await tx
              .update(rang)
              .set({
                abzeichenBild: bild.inhalt,
                abzeichenBildTyp: bild.typ,
                abzeichenSterne: null,
              })
              .where(and(eq(rang.id, rangId), eq(rang.einheitId, einheitId)));
            await protokolliere(tx, {
              einheitId,
              akteurId: person.id,
              aktion: "rang_abzeichen_gesetzt",
              zielTyp: "rang",
              zielId: rangId,
              details: { typ: bild.typ },
            });
          });
          return c.body(null, 204);
        },
      )
      .delete("/:rangId/abzeichen", eingabe("param", rangPfad), async (c) => {
        const person = c.get("person");
        const { einheitId, rangId } = c.req.valid("param");
        await pruefeEinheit(db, person, einheitId, "verwalten");
        await zeigeRang(einheitId, rangId);
        await db.transaction(async (tx) => {
          await tx
            .update(rang)
            .set({
              abzeichenBild: null,
              abzeichenBildTyp: null,
              abzeichenSterne: null,
            })
            .where(and(eq(rang.id, rangId), eq(rang.einheitId, einheitId)));
          await protokolliere(tx, {
            einheitId,
            akteurId: person.id,
            aktion: "rang_abzeichen_entfernt",
            zielTyp: "rang",
            zielId: rangId,
          });
        });
        return c.body(null, 204);
      })
  );
}
