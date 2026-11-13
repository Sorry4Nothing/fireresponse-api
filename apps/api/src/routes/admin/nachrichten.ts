import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { auditLog, nachricht, nachrichtGelesen } from "../../db/schema.js";
import { erstelleDrosselung, LIMIT_NACHRICHTEN } from "../../drosselung.js";
import { eingabe } from "../../eingabe.js";
import { hatVerwaltung, type Person } from "../../rechte.js";

// Nur Text: Der Titel in einer Zeile, der Text mit Zeilenumbrüchen; sonst keine Steuerzeichen
const titel = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}]*$/u);
const text = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .regex(/^(?:[^\p{Cc}]|\n)*$/u);

const anlegenSchema = z.strictObject({
  titel,
  text,
  // Ab dann zeigt die Glocke die Mitteilung nicht mehr; ohne Angabe bleibt sie
  laeuftAbAm: z.iso
    .datetime({ offset: true })
    .refine((wert) => new Date(wert) > new Date())
    .nullable()
    .optional(),
});
const idPfad = z.strictObject({ id: z.uuid() });

// Die Empfänger: aktive Konten mit Kommando oder Stellvertretung. Leitende haben keinen Zugang zur Verwaltung, der Kantonsadmin schreibt die Mitteilungen nur
const EMPFAENGER = sql`select r.user_id from einheit_rolle r join "user" u on u.id = r.user_id where r.typ in ('kommandant', 'stellvertretung') and u.deaktiviert_am is null and u.banned is not true`;

// Die Zahl der Mitteilungen in der Liste; die Glocke braucht nur die jüngsten
const MAXIMUM = 100;

const nurKantonsadmin = createMiddleware<{ Variables: { person: Person } }>(
  async (c, next) => {
    if (!c.get("person").kantonsadmin) throw new HTTPException(403);
    await next();
  },
);

// Die Glocke der Verwaltung. Lesen dürfen alle Konten der Verwaltung, schreiben und zurückziehen nur der Kantonsadmin; als gelesen markiert jedes Empfänger-Konto für sich. Der Kantonsadmin sieht die Zahl der Lesenden, nie die Konten. Das Audit-Log nennt nie den Text
export function erstelleNachrichtenRouten({ db }: { db: Db }) {
  // Pro Instanz: Der Zähler gehört dieser App
  const senden = erstelleDrosselung(LIMIT_NACHRICHTEN);
  const sichtbar = or(
    isNull(nachricht.laeuftAbAm),
    gt(nachricht.laeuftAbAm, sql`now()`),
  );

  return (
    new Hono<{ Variables: { person: Person } }>()
      .get("/", async (c) => {
        const person = c.get("person");
        if (!hatVerwaltung(person)) throw new HTTPException(403);
        const felder = {
          id: nachricht.id,
          titel: nachricht.titel,
          text: nachricht.text,
          erstelltAm: nachricht.erstelltAm,
          laeuftAbAm: nachricht.laeuftAbAm,
        };
        if (person.kantonsadmin) {
          const zeilen = await db
            .select({
              ...felder,
              abgelaufen: sql<boolean>`coalesce("nachricht"."laeuft_ab_am" <= now(), false)`,
              lesende: sql<number>`(select count(*) from ${nachrichtGelesen} g where g.nachricht_id = "nachricht"."id" and g.user_id in (${EMPFAENGER}))::int`,
            })
            .from(nachricht)
            .orderBy(desc(nachricht.erstelltAm), desc(nachricht.id))
            .limit(MAXIMUM);
          const [{ n }] = await db.execute<{ n: number }>(
            sql`select count(distinct user_id)::int as n from (${EMPFAENGER}) e`,
          );
          return c.json({ nachrichten: zeilen, empfaenger: n });
        }
        const zeilen = await db
          .select({
            ...felder,
            gelesen: sql<boolean>`exists (select 1 from ${nachrichtGelesen} g where g.nachricht_id = "nachricht"."id" and g.user_id = ${person.id})`,
          })
          .from(nachricht)
          .where(sichtbar)
          .orderBy(desc(nachricht.erstelltAm), desc(nachricht.id))
          .limit(MAXIMUM);
        return c.json({ nachrichten: zeilen });
      })
      .post(
        "/",
        nurKantonsadmin,
        senden,
        eingabe("json", anlegenSchema),
        async (c) => {
          const person = c.get("person");
          const neu = c.req.valid("json");
          const [zeile] = await db.transaction(async (tx) => {
            const [zeile] = await tx
              .insert(nachricht)
              .values({
                titel: neu.titel,
                text: neu.text,
                laeuftAbAm: neu.laeuftAbAm ? new Date(neu.laeuftAbAm) : null,
              })
              .returning({
                id: nachricht.id,
                erstelltAm: nachricht.erstelltAm,
                laeuftAbAm: nachricht.laeuftAbAm,
              });
            await tx.insert(auditLog).values({
              akteurId: person.id,
              aktion: "nachricht_gesendet",
              zielTyp: "nachricht",
              zielId: zeile.id,
              details: { mitAblauf: zeile.laeuftAbAm !== null },
            });
            return [zeile];
          });
          return c.json(zeile, 201);
        },
      )
      // Vor «/:id/gelesen», damit «gelesen» nie als ID gilt
      .post("/gelesen", async (c) => {
        const person = c.get("person");
        if (!hatVerwaltung(person) || person.kantonsadmin) {
          throw new HTTPException(403);
        }
        await db.execute(
          sql`insert into nachricht_gelesen (nachricht_id, user_id) select id, ${person.id}::uuid from nachricht where laeuft_ab_am is null or laeuft_ab_am > now() on conflict do nothing`,
        );
        return c.body(null, 204);
      })
      .put("/:id/gelesen", eingabe("param", idPfad), async (c) => {
        const person = c.get("person");
        if (!hatVerwaltung(person) || person.kantonsadmin) {
          throw new HTTPException(403);
        }
        const { id } = c.req.valid("param");
        const [da] = await db
          .select({ id: nachricht.id })
          .from(nachricht)
          .where(and(eq(nachricht.id, id), sichtbar));
        if (!da) throw new HTTPException(404);
        await db
          .insert(nachrichtGelesen)
          .values({ nachrichtId: id, userId: person.id })
          .onConflictDoNothing();
        return c.body(null, 204);
      })
      .delete("/:id", nurKantonsadmin, eingabe("param", idPfad), async (c) => {
        const person = c.get("person");
        const { id } = c.req.valid("param");
        await db.transaction(async (tx) => {
          const geloescht = await tx
            .delete(nachricht)
            .where(eq(nachricht.id, id))
            .returning({ id: nachricht.id });
          if (geloescht.length === 0) throw new HTTPException(404);
          await tx.insert(auditLog).values({
            akteurId: person.id,
            aktion: "nachricht_zurueckgezogen",
            zielTyp: "nachricht",
            zielId: id,
          });
        });
        return c.body(null, 204);
      })
  );
}
