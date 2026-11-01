import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test, vi } from "vitest";
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { ladeSeiten } from "../src/seiten.js";
import {
  APP,
  bereiteAuthTestsVor,
  cookiesAus,
  erstelleTestAuth,
  zufallsIp,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  totpCode,
  type Persona,
  type PersonaKonto,
  type Welt,
} from "./hilfen/personas.js";

bereiteAuthTestsVor();
// Jede Persona und jede Anmeldung rechnet scrypt
vi.setConfig({ hookTimeout: 120_000 });

const sql = postgres(API_URL);
const db = erstelleDb(sql);
const auth = erstelleTestAuth(db);
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  seiten: ladeSeiten(),
});
afterAll(() => sql.end());

type Kopfzeilen = Record<string, string>;

// Eigene Welt pro Test: Die Fälle hängen an der genauen Zahl aktiver Admins ihrer Abteilung
async function eigeneWelt(persona: Persona = "admin") {
  const welt = await erstelleWelt(db, auth);
  return {
    welt,
    konto: await legePersonaAn(welt, persona),
    // Mit zweitem Faktor: Ohne ihn sperrt die Admin-Sperre (#23) die Anfragen an /api/v1/admin/*
    admin: await legePersonaAn(welt, "admin"),
  };
}

// Die Person löscht ihr Konto nicht selbst; das tut ein Admin (DELETE /api/v1/ich gibt es nicht mehr, #180)
const loesche = (aktor: PersonaKonto, zielId: string) =>
  app.request(`/api/v1/admin/personen/${zielId}`, {
    method: "DELETE",
    headers: aktor.headers,
  });
const post = (pfad: string, headers: Kopfzeilen, body: object) =>
  app.request(pfad, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      "x-forwarded-for": zufallsIp(),
    },
    body: JSON.stringify(body),
  });
const hole = (pfad: string, headers: Kopfzeilen) =>
  app.request(pfad, { headers });
const meldeAn = (konto: PersonaKonto) =>
  post(
    "/api/auth/sign-in/username",
    { "expo-origin": APP },
    { username: konto.benutzername, password: konto.passwort },
  );

// Eine zweite Sitzung, wie die App: Anmeldung, dann der Code des zweiten Faktors
async function zweiteSitzung(welt: Welt, konto: PersonaKonto) {
  const zwischen = cookiesAus(await meldeAn(konto));
  const antwort = await post(
    "/api/auth/two-factor/verify-totp",
    { "expo-origin": APP, cookie: zwischen },
    { code: await totpCode(welt, konto.id!) },
  );
  expect(antwort.status).toBe(200);
  return { "expo-origin": APP, cookie: cookiesAus(antwort) };
}

const userZeile = async (id: string) =>
  (await db.select().from(schema.user).where(eq(schema.user.id, id)))[0];
const sitzungen = (id: string) =>
  db.select().from(schema.session).where(eq(schema.session.userId, id));
const auditZeilen = (zielId: string) =>
  db.select().from(schema.auditLog).where(eq(schema.auditLog.zielId, zielId));

// Jede Spalte der Datenbank, die Text oder eine UUID trägt, auf einen der Werte; die Liste kommt aus dem Katalog, spätere Tabellen sind also dabei
async function treffer(werte: string[]) {
  const spalten = await sql<{ tabelle: string; spalte: string }[]>`
    select table_name as tabelle, column_name as spalte
    from information_schema.columns
    where table_schema = 'public'
      and data_type in ('uuid', 'text', 'character varying', 'jsonb')`;
  const gefunden: string[] = [];
  for (const { tabelle, spalte } of spalten) {
    for (const wert of werte) {
      const zeilen = await sql`
        select 1 from ${sql(tabelle)}
        where strpos(${sql(spalte)}::text, ${wert}) > 0 limit 1`;
      if (zeilen.length > 0) gefunden.push(`${tabelle}.${spalte}`);
    }
  }
  return gefunden;
}

describe("Konto löschen durch einen Admin", () => {
  test("nach dem Löschen zeigt keine Zeile mehr auf die Person, ausser dem Audit-Log", async () => {
    const { welt, konto: admin, admin: aktor } = await eigeneWelt();
    const id = admin.id!;
    const anderesElternteil = await legePersonaAn(welt, "elternA");
    await db
      .insert(schema.rolle)
      .values({ userId: id, stufeId: welt.stufeAId, typ: "leitung" });
    await db
      .insert(schema.kindEltern)
      .values({ userId: id, kindId: welt.kindAId });
    const zweite = await zweiteSitzung(welt, admin);
    // Eine Anmeldung bleibt beim Code stehen: Die Zeile «2fa-…» trägt die ID der Person
    expect(await (await meldeAn(admin)).json()).toMatchObject({
      twoFactorRedirect: true,
    });
    const [eigeneSitzung] = await sitzungen(id);
    await db.insert(schema.pushToken).values({
      sessionId: eigeneSitzung.id,
      userId: id,
      token: randomUUID(),
      plattform: "ios",
    });
    await db.insert(schema.auditLog).values({
      abteilungId: welt.testabteilungId,
      akteurId: id,
      aktion: "zweiter_faktor_zurueckgesetzt",
      zielTyp: "person",
      zielId: id,
    });
    expect((await sitzungen(id)).length).toBeGreaterThanOrEqual(2);
    const verifikation = await db
      .select()
      .from(schema.verification)
      .where(eq(schema.verification.value, id));
    expect(verifikation.length).toBeGreaterThanOrEqual(1);
    const { email } = await userZeile(id);

    const antwort = await loesche(aktor, id);
    expect(antwort.status).toBe(204);
    expect(await antwort.text()).toBe("");

    expect(await userZeile(id)).toBeUndefined();
    // Nur im Audit-Log, und da nur die ID: weder Benutzername noch E-Mail-Adresse stehen irgendwo
    const mitId = await treffer([id]);
    expect(new Set(mitId)).toEqual(
      new Set(["audit_log.akteur_id", "audit_log.ziel_id"]),
    );
    expect(await treffer([admin.benutzername!, email])).toEqual([]);
    expect(await auditZeilen(id)).toHaveLength(2);
    expect(
      (await auditZeilen(id)).find((z) => z.aktion === "person_geloescht"),
    ).toMatchObject({
      abteilungId: welt.testabteilungId,
      akteurId: aktor.id,
      zielTyp: "person",
      zielId: id,
      details: null,
    });
    // Kinder sind Einträge ohne Konto, das andere Elternteil behält seine Zuordnung
    const [kind] = await db
      .select()
      .from(schema.kind)
      .where(eq(schema.kind.id, welt.kindAId));
    expect(kind).toBeDefined();
    expect(
      await db
        .select()
        .from(schema.kindEltern)
        .where(
          and(
            eq(schema.kindEltern.kindId, welt.kindAId),
            eq(schema.kindEltern.userId, anderesElternteil.id!),
          ),
        ),
    ).toHaveLength(1);

    // Beide Sitzungen sind ungültig, die Anmeldung gibt den einen Fehler
    for (const headers of [admin.headers, zweite]) {
      expect((await hole("/api/v1/ich", headers)).status).toBe(401);
    }
    const neu = await meldeAn(admin);
    expect(neu.status).toBe(401);
    expect(await neu.json()).toMatchObject({
      code: "ANMELDUNG_FEHLGESCHLAGEN",
    });
  });
});
