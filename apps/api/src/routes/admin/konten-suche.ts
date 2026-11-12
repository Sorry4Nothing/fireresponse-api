import {
  and,
  asc,
  eq,
  exists,
  ilike,
  inArray,
  not,
  or,
  sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import {
  einheitRolle,
  profilbild,
  teilnehmende,
  teilnehmendeKonto,
  user,
} from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import { aktivesKonto, pruefeEinheit, type Person } from "../../rechte.js";

const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const frageSchema = z.strictObject({
  q: z.string().trim().min(2).max(64),
  // leitung: Konto mit Rolle (wie POST /leitende/bestehend); eltern: Elternkonto (wie bestehendesKonto beim Anlegen)
  fuer: z.enum(["leitung", "eltern"]),
});

const MAX_TREFFER = 10;

// LIKE-Platzhalter in der Eingabe sind Text
const alsMuster = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

// Vorschläge für die Felder «Benutzername» in der Verwaltung. Geltungsbereich wie beim Zuweisen: Das Kommando sieht nur Konten aus Einheiten, die es selbst verwaltet, der Kantonsadmin alle. Mehr als Kennung, Name, Benutzername und ob ein Profilbild vorliegt kommt nie zurück
export function erstelleKontenSucheRouten({ db }: { db: Db }) {
  return new Hono<{ Variables: { person: Person } }>().get(
    "/",
    eingabe("param", einheitPfad),
    eingabe("query", frageSchema),
    async (c) => {
      const person = c.get("person");
      const { einheitId } = c.req.valid("param");
      const { q, fuer } = c.req.valid("query");
      await pruefeEinheit(db, person, einheitId, "verwalten");
      const verwaltet = person.einheiten
        .filter((r) => r.typ !== "leitung")
        .map((r) => r.einheitId);
      const muster = alsMuster(q);
      const passt = or(ilike(user.name, muster), ilike(user.username, muster));
      const grundlage = and(
        passt,
        aktivesKonto(),
        sql`${user.role} is distinct from 'admin'`,
      );
      let bedingung;
      if (fuer === "leitung") {
        const rolleIn = (ids: string[]) =>
          db
            .select({ x: sql`1` })
            .from(einheitRolle)
            .where(
              and(
                sql`${einheitRolle.userId} = ${user.id}`,
                inArray(einheitRolle.einheitId, ids),
              ),
            );
        bedingung = and(
          grundlage,
          not(exists(rolleIn([einheitId]))),
          person.kantonsadmin
            ? exists(
                db
                  .select({ x: sql`1` })
                  .from(einheitRolle)
                  .where(sql`${einheitRolle.userId} = ${user.id}`),
              )
            : verwaltet.length > 0
              ? exists(rolleIn(verwaltet))
              : sql`false`,
        );
      } else {
        const elternVon = db
          .select({ x: sql`1` })
          .from(teilnehmendeKonto)
          .innerJoin(
            teilnehmende,
            sql`${teilnehmende.id} = ${teilnehmendeKonto.teilnehmendeId}`,
          )
          .where(
            and(
              sql`${teilnehmendeKonto.userId} = ${user.id}`,
              sql`${teilnehmendeKonto.art} = 'eltern'`,
              person.kantonsadmin
                ? undefined
                : verwaltet.length > 0
                  ? inArray(teilnehmende.einheitId, verwaltet)
                  : sql`false`,
            ),
          );
        const selbst = db
          .select({ x: sql`1` })
          .from(teilnehmendeKonto)
          .where(
            and(
              sql`${teilnehmendeKonto.userId} = ${user.id}`,
              sql`${teilnehmendeKonto.art} = 'selbst'`,
            ),
          );
        bedingung = and(grundlage, exists(elternVon), not(exists(selbst)));
      }
      const konten = await db
        .select({
          id: user.id,
          benutzername: user.username,
          name: user.name,
          // Eltern sieht das Kommando nie mit Bild (wie darfBildSehen); dort bleiben die Initialen
          hatBild:
            fuer === "leitung"
              ? sql<boolean>`${profilbild.userId} is not null`
              : sql<boolean>`false`,
        })
        .from(user)
        .leftJoin(profilbild, eq(profilbild.userId, user.id))
        .where(bedingung)
        .orderBy(asc(user.name), asc(user.id))
        .limit(MAX_TREFFER);
      return c.json({ konten });
    },
  );
}
