import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { erstelleAuth } from "./auth.js";
import type { Db } from "./db/client.js";
import {
  einheit,
  einheitRolle,
  teilnehmende,
  teilnehmendeKonto,
  user,
} from "./db/schema.js";
import { EINWILLIGUNG_VERSION } from "./einwilligung.js";

export type RollenTyp = "kommandant" | "stellvertretung" | "leitung";

// Welche Einheiten eine Abfrage braucht; einheitenFuer liefert pro Zweck die erlaubte Menge
export type Zweck = "lesen" | "antworten" | "verwalten" | "stellvertretungen";

// Eltern und Teilnehmende haben keine Rolle in einer Einheit: Ihre Rechte hängen an teilnehmende_konto
export type Person = {
  id: string;
  // Kantonsadmin = better-auth-Rolle «admin»
  kantonsadmin: boolean;
  zweiterFaktor: boolean;
  // Hat die Person die aktuelle Fassung der Einwilligung bestätigt?
  einwilligung: boolean;
  // Kommando und Leitende mit ihrer Rolle
  einheiten: { einheitId: string; typ: RollenTyp }[];
  // Einheiten mit mindestens einer aktiven teilnehmenden Person, für die das Konto antwortet
  teilnehmendeEinheiten: string[];
};

// Diese Routen bleiben ohne gültige Einwilligung offen: das Profil (GET) und die Einwilligung selbst. Passwortwechsel und Abmelden laufen über /api/auth
const ohneEinwilligung = (methode: string, pfad: string) =>
  pfad === "/api/v1/einwilligung" ||
  (methode === "GET" && pfad === "/api/v1/ich");

// Jede Route unter /api/v1 lädt ihr Objekt in SQL auf einheitenFuer() gefiltert, sonst HTTPException(404); erst dann prüft sie das Recht, sonst HTTPException(403)
export function personAusSitzung(
  auth: ReturnType<typeof erstelleAuth>,
  db: Db,
) {
  return createMiddleware<{
    Variables: { person: Person; sitzungId: string; nutzerId: string };
  }>(async (c, next) => {
    // disableRefresh: Die Verlängerung gehört zu get-session; hier schriebe sie die Zeile und verlöre ihr Set-Cookie
    const sitzung = await auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableRefresh: true },
    });
    // Für das Anfrage-Log bei 401 und 403; vor den Prüfungen, damit auch ein gesperrtes Konto und der Pflichtwechsel die ID zeigen
    if (sitzung) c.set("nutzerId", sitzung.user.id);
    // banned prüft better-auth nur beim Anlegen einer Sitzung, nicht beim Lesen
    if (!sitzung || sitzung.user.banned) throw new HTTPException(401);
    // Bis zum Pflichtwechsel nur das eigene Profil; den Zustand kennt die App aus get-session
    if (
      sitzung.user.mussPasswortAendern &&
      !(c.req.method === "GET" && c.req.path === "/api/v1/ich")
    ) {
      throw new HTTPException(403);
    }
    const einheiten = await db
      .select({ einheitId: einheitRolle.einheitId, typ: einheitRolle.typ })
      .from(einheitRolle)
      .where(eq(einheitRolle.userId, sitzung.user.id));
    const teilnehmendeEinheiten = await db
      .selectDistinct({ einheitId: teilnehmende.einheitId })
      .from(teilnehmendeKonto)
      .innerJoin(
        teilnehmende,
        and(
          eq(teilnehmende.id, teilnehmendeKonto.teilnehmendeId),
          isNull(teilnehmende.inaktivSeit),
        ),
      )
      .where(eq(teilnehmendeKonto.userId, sitzung.user.id));
    const einwilligung =
      (sitzung.user.einwilligungVersion ?? 0) >= EINWILLIGUNG_VERSION;
    const person: Person = {
      id: sitzung.user.id,
      kantonsadmin: sitzung.user.role === "admin",
      zweiterFaktor: sitzung.user.twoFactorEnabled === true,
      einwilligung,
      einheiten,
      teilnehmendeEinheiten: teilnehmendeEinheiten.map((z) => z.einheitId),
    };
    c.set("person", person);
    // Nie aus der Anfrage: Das Push-Token hängt an der Sitzung, die better-auth aus dem Cookie liest
    c.set("sitzungId", sitzung.session.id);
    // Die Verwaltung hat ihren eigenen Zugang (zweiter Faktor) und fragt die Einwilligung der App nicht ab
    if (
      !einwilligung &&
      !c.req.path.startsWith("/api/v1/admin/") &&
      !ohneEinwilligung(c.req.method, c.req.path)
    ) {
      return c.json(
        {
          code: "EINWILLIGUNG_FEHLT",
          message: "Bitte zuerst der aktuellen Einwilligung zustimmen.",
        },
        403,
      );
    }
    await next();
  });
}

// Wer in die Verwaltung gehört: Kantonsadmin, Kommandantin oder Kommandant und Stellvertretungen
export const hatVerwaltung = (person: Person) =>
  person.kantonsadmin ||
  person.einheiten.some(
    (r) => r.typ === "kommandant" || r.typ === "stellvertretung",
  );

// Für den Pfad zum zweiten Faktor, der vor der Sitzung der App läuft: Kommando oder Stellvertretung irgendeiner Einheit
export async function hatKommandoOderStellvertretung(db: Db, userId: string) {
  const [zeile] = await db
    .select({ userId: einheitRolle.userId })
    .from(einheitRolle)
    .where(
      and(
        eq(einheitRolle.userId, userId),
        inArray(einheitRolle.typ, ["kommandant", "stellvertretung"]),
      ),
    )
    .limit(1);
  return zeile !== undefined;
}

// Verwaltungs-Routen erst mit zweitem Faktor; eigener Code, damit die App zur Einrichtung führt. Alle anderen passen vorbei und behalten das 403/404 der Route
export const zweiterFaktorPflicht = createMiddleware<{
  Variables: { person: Person };
}>(async (c, next) => {
  const person = c.get("person");
  if (hatVerwaltung(person) && !person.zweiterFaktor) {
    return c.json(
      {
        code: "ZWEITER_FAKTOR_FEHLT",
        message: "Für die Verwaltung braucht es zuerst einen zweiten Faktor.",
      },
      403,
    );
  }
  await next();
});

// Die Einheiten, die die Person für diesen Zweck sehen oder ändern darf. Jede Abfrage filtert damit mit einheitId IN (…); eine leere Liste lässt nichts durch
export async function einheitenFuer(
  db: Db,
  person: Person,
  zweck: Zweck,
): Promise<string[]> {
  if (person.kantonsadmin) {
    // Das Kantonsadmin-Konto hat keine eigene Rolle und antwortet nie
    if (zweck === "antworten") return [];
    const alle = await db.select({ id: einheit.id }).from(einheit);
    return alle.map((e) => e.id);
  }
  const rollen = person.einheiten.filter((r) => {
    if (zweck === "stellvertretungen") return r.typ === "kommandant";
    if (zweck === "verwalten") {
      return r.typ === "kommandant" || r.typ === "stellvertretung";
    }
    return true;
  });
  const ids = rollen.map((r) => r.einheitId);
  if (zweck === "lesen") ids.push(...person.teilnehmendeEinheiten);
  return [...new Set(ids)];
}

// Fremde wie unbekannte Einheiten sind 404, erst danach zählt das Recht für den Zweck (403)
export async function pruefeEinheit(
  db: Db,
  person: Person,
  einheitId: string,
  zweck: Zweck,
) {
  if (!(await einheitenFuer(db, person, "lesen")).includes(einheitId)) {
    throw new HTTPException(404);
  }
  if (
    zweck !== "lesen" &&
    !(await einheitenFuer(db, person, zweck)).includes(einheitId)
  ) {
    throw new HTTPException(403);
  }
}

// banned ist null-sicher geprüft; Deaktivieren setzt beide Felder, jedes allein beendet die Mitgliedschaft
export function aktivesKonto() {
  return and(isNull(user.deaktiviertAm), sql`${user.banned} is not true`);
}

// Der Kommandant zuerst, dann die Stellvertretungen nach Reihenfolge, dann die Leitenden: die Reihenfolge der Kontakte
export const rollenReihenfolge = sql`case ${einheitRolle.typ} when 'kommandant' then 0 when 'stellvertretung' then 1 else 2 end, ${einheitRolle.reihenfolge} nulls last`;

// Hat die Person in dieser Einheit Kommando oder Leitung?
export const hatRolleIn = (person: Person, einheitId: string) =>
  person.einheiten.some((r) => r.einheitId === einheitId);

// Spalten bewusst als Text «programm.…»: In der Feldliste eines Selects liesse Drizzle den Tabellennamen weg
export function programmSichtbar(einheitIds: string[]): SQL {
  // inArray mit leerer Liste wird zu «false»: Ohne Einheit bleibt alles verborgen
  return inArray(sql`programm.einheit_id`, einheitIds);
}

// Termine «nur Leitende» sehen nur das Kantonsadmin-Konto sowie Kommando, Stellvertretung und Leitende der Einheit des Termins; für alle anderen sind sie unsichtbar (404)
export function terminFuerPerson(person: Person): SQL {
  if (person.kantonsadmin) return sql`true`;
  return sql`(not programm.nur_leitende or ${inArray(
    sql`programm.einheit_id`,
    person.einheiten.map((r) => r.einheitId),
  )})`;
}

// Beginn des Programms; ganztägige beginnen um 00:00 Schweizer Zeit, nie über die Sitzungszone (tag_von::timestamptz)
export const programmBeginn: SQL = sql`coalesce(programm.beginn, programm.tag_von::timestamp at time zone 'Europe/Zurich')`;
