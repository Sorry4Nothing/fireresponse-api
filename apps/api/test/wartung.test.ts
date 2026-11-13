import { eq } from "drizzle-orm";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { ladeSeiten } from "../src/seiten.js";
import {
  APP,
  bereiteAuthTestsVor,
  erstelleTestAuth,
  zufallsIp,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  type PersonaKonto,
  type Welt,
} from "./hilfen/personas.js";

bereiteAuthTestsVor();

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
afterAll(async () => {
  await sql.end();
});

const STANDARD = "FireResponse wird gerade gewartet.";
const AUS = { aktiv: false, text: null, ende: null, seit: null };

let welt: Welt;
let admin: PersonaKonto;
let kommando: PersonaKonto;
let eltern: PersonaKonto;
let ohneLogin: PersonaKonto;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  [admin, kommando, eltern, ohneLogin] = await Promise.all([
    legePersonaAn(welt, "kantonsadmin"),
    legePersonaAn(welt, "kommandoJfA"),
    legePersonaAn(welt, "elternJfA"),
    legePersonaAn(welt, "ohneLogin"),
  ]);
});

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
// Der Zustand ist global: Jeder Test beginnt und endet mit Wartung aus
afterEach(async () => {
  ausgabe.mockRestore();
  await db
    .update(schema.wartung)
    .set({ aktiv: false, text: null, ende: null, seit: null })
    .where(eq(schema.wartung.id, schema.WARTUNG_ID));
});

const schalte = (konto: PersonaKonto, body: unknown) =>
  app.request("/api/v1/admin/system/wartung", {
    method: "PUT",
    headers: { ...konto.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const status = (konto?: PersonaKonto) =>
  app.request("/api/v1/wartung", { headers: konto?.headers });
const hole = (konto: PersonaKonto, pfad: string) =>
  app.request(pfad, { headers: konto.headers });
const anmelden = (konto: PersonaKonto, kopf: Record<string, string> = {}) =>
  app.request("/api/auth/sign-in/username", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "expo-origin": APP,
      "x-forwarded-for": zufallsIp(),
      ...kopf,
    },
    body: JSON.stringify({
      username: konto.benutzername,
      password: konto.passwort,
    }),
  });

describe("GET /api/v1/wartung", () => {
  test("ohne Sitzung 200: aus, mit leeren Feldern", async () => {
    const antwort = await status(ohneLogin);
    expect(antwort.status).toBe(200);
    expect(await antwort.json()).toEqual(AUS);
    expect(antwort.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("PUT /api/v1/admin/system/wartung", () => {
  test("nur das Kantonsadmin-Konto schaltet: Kommando 403, ohne Sitzung 401", async () => {
    expect((await schalte(kommando, { aktiv: true })).status).toBe(403);
    expect((await schalte(ohneLogin, { aktiv: true })).status).toBe(401);
    expect(await (await status()).json()).toEqual(AUS);
  });

  test("schaltet ein mit Text und Ende; der öffentliche Status zeigt es", async () => {
    const ende = "2026-11-13T21:00:00+01:00";
    const antwort = await schalte(admin, {
      aktiv: true,
      text: "  Wir spielen ein Update ein.  ",
      ende,
    });
    expect(antwort.status).toBe(200);
    const gesetzt = await antwort.json();
    expect(gesetzt).toEqual({
      aktiv: true,
      text: "Wir spielen ein Update ein.",
      ende: new Date(ende).toISOString(),
      seit: expect.any(String),
    });
    expect(await (await status(ohneLogin)).json()).toEqual(gesetzt);
  });

  test("ohne Text und Ende bleiben beide leer; ein leerer Text zählt als leer", async () => {
    await schalte(admin, { aktiv: true, text: "   " });
    expect(await (await status()).json()).toMatchObject({
      aktiv: true,
      text: null,
      ende: null,
    });
  });

  test("erneutes Einschalten ändert Text und Ende, nicht «seit»", async () => {
    const erste = await (await schalte(admin, { aktiv: true })).json();
    const zweite = await (
      await schalte(admin, { aktiv: true, text: "Neu" })
    ).json();
    expect(zweite).toMatchObject({ text: "Neu", seit: erste.seit });
  });

  test("ausschalten leert Text, Ende und seit", async () => {
    await schalte(admin, {
      aktiv: true,
      text: "x",
      ende: "2030-01-01T00:00:00Z",
    });
    const antwort = await schalte(admin, { aktiv: false });
    expect(antwort.status).toBe(200);
    expect(await antwort.json()).toEqual(AUS);
    expect(await (await status()).json()).toEqual(AUS);
  });

  test.each([
    ["Text über 280 Zeichen", { aktiv: true, text: "a".repeat(281) }],
    ["Ende ohne Zeitzone", { aktiv: true, ende: "2030-01-01T10:00:00" }],
    ["Ende kein Zeitpunkt", { aktiv: true, ende: "morgen" }],
    ["aktiv fehlt", { text: "x" }],
    ["aktiv kein Boolean", { aktiv: "ja" }],
    ["unbekanntes Feld", { aktiv: true, seit: "2030-01-01T00:00:00Z" }],
    ["ausschalten mit Text", { aktiv: false, text: "x" }],
  ])("%s ist 400 und ändert nichts", async (_name, body) => {
    expect((await schalte(admin, body)).status).toBe(400);
    expect(await (await status()).json()).toEqual(AUS);
  });

  test("280 Zeichen sind erlaubt", async () => {
    const text = "ä".repeat(280);
    expect((await schalte(admin, { aktiv: true, text })).status).toBe(200);
    expect(await (await status()).json()).toMatchObject({ text });
  });

  test("schreibt das Protokoll ohne den Text; Aus ohne Wechsel schreibt nichts", async () => {
    const vorher = (await db.select().from(schema.auditLog)).length;
    await schalte(admin, { aktiv: false });
    await schalte(admin, {
      aktiv: true,
      text: "geheimer Text",
      ende: "2030-01-01T00:00:00Z",
    });
    await schalte(admin, { aktiv: true, text: "anderer Text" });
    await schalte(admin, { aktiv: false });
    const neu = (
      await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.zielId, schema.WARTUNG_ID))
        .orderBy(schema.auditLog.id)
    ).slice(-3);
    expect(neu.map((z) => z.aktion)).toEqual([
      "wartung_eingeschaltet",
      "wartung_geaendert",
      "wartung_ausgeschaltet",
    ]);
    expect(neu[0]).toMatchObject({
      akteurId: admin.id,
      einheitId: null,
      zielTyp: "wartung",
    });
    expect(JSON.stringify(neu)).not.toContain("Text");
    expect((await db.select().from(schema.auditLog)).length - vorher).toBe(3);
  });
});

describe("Wartung aktiv", () => {
  beforeEach(async () => {
    await schalte(admin, { aktiv: true, ende: "2030-01-01T00:00:00Z" });
  });

  test("App-Routen antworten vor der Sitzungsprüfung mit 503 WARTUNG und Retry-After", async () => {
    // Ohne Sitzung wäre es 401, mit Eltern ohne Einwilligung 403, unbekannt 404
    for (const konto of [ohneLogin, eltern]) {
      for (const pfad of [
        "/api/v1/ich",
        "/api/v1/programme",
        "/api/v1/gibtsnicht",
      ]) {
        const antwort = await hole(konto, pfad);
        expect(antwort.status).toBe(503);
        expect(await antwort.json()).toEqual({
          code: "WARTUNG",
          message: expect.stringContaining(STANDARD),
          ende: "2030-01-01T00:00:00.000Z",
        });
        expect(antwort.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
        expect(antwort.headers.get("Cache-Control")).toBe("no-store");
      }
    }
  });

  test("schreibende Aufrufe sind gesperrt, auch ohne gültigen Body", async () => {
    const antwort = await app.request("/api/v1/push-token", {
      method: "PUT",
      headers: eltern.headers,
      body: "kein json",
    });
    expect(antwort.status).toBe(503);
  });

  test("die Meldung ist der Text des Panels, sonst der Standardtext; ohne Ende ist ende null und Retry-After 300", async () => {
    await schalte(admin, { aktiv: true, text: "Update bis später." });
    const mitText = await hole(eltern, "/api/v1/ich");
    expect(await mitText.json()).toEqual({
      code: "WARTUNG",
      message: "Update bis später.",
      ende: null,
    });
    expect(mitText.headers.get("Retry-After")).toBe("300");
  });

  test("Retry-After folgt dem Ende, höchstens eine Stunde", async () => {
    const in10Min = new Date(Date.now() + 600_000).toISOString();
    await schalte(admin, { aktiv: true, ende: in10Min });
    const kurz = Number(
      (await hole(eltern, "/api/v1/ich")).headers.get("Retry-After"),
    );
    expect(kurz).toBeGreaterThan(590);
    expect(kurz).toBeLessThanOrEqual(600);
    await schalte(admin, { aktiv: true, ende: "2030-01-01T00:00:00Z" });
    expect((await hole(eltern, "/api/v1/ich")).headers.get("Retry-After")).toBe(
      "3600",
    );
    // Ein verstrichenes Ende beendet die Wartung nicht; der Wert fällt auf den Standard
    await schalte(admin, { aktiv: true, ende: "2020-01-01T00:00:00Z" });
    expect((await hole(eltern, "/api/v1/ich")).headers.get("Retry-After")).toBe(
      "300",
    );
  });

  test("ausgenommen: Status, Datenschutz, Verwaltungs-API und /health", async () => {
    expect((await status(ohneLogin)).status).toBe(200);
    expect((await hole(ohneLogin, "/api/v1/datenschutz")).status).toBe(200);
    expect((await hole(admin, "/api/v1/admin/system")).status).toBe(200);
    expect((await hole(ohneLogin, "/health")).status).toBe(200);
    // Auch die Verwaltung bleibt Verwaltung: ohne Sitzung 401, nicht 503
    expect((await hole(ohneLogin, "/api/v1/admin/system")).status).toBe(401);
  });

  test("die Anmeldung mit X-App-Version ist 503 WARTUNG, ohne den Header geht sie durch", async () => {
    const mit = await anmelden(eltern, { "X-App-Version": "1.2.0" });
    expect(mit.status).toBe(503);
    expect(await mit.json()).toMatchObject({ code: "WARTUNG" });
    expect(mit.headers.get("Retry-After")).toBeTruthy();
    expect((await anmelden(eltern)).status).toBe(200);
  });

  test("andere Auth-Pfade bleiben offen: Sitzung lesen und abmelden", async () => {
    const antwort = await app.request("/api/auth/get-session", {
      headers: eltern.headers,
    });
    expect(antwort.status).toBe(200);
  });

  test("nach dem Ausschalten laufen die Routen wieder", async () => {
    expect((await hole(eltern, "/api/v1/ich")).status).toBe(503);
    await schalte(admin, { aktiv: false });
    expect((await hole(eltern, "/api/v1/ich")).status).toBe(200);
    expect((await anmelden(eltern, { "X-App-Version": "1.2.0" })).status).toBe(
      200,
    );
  });
});

test("die Datenbank hält die Zeile ein: eine Zeile, Text höchstens 280 Zeichen, Aus ist leer", async () => {
  await expect(
    sql`insert into wartung (id) values (uuidv7())`,
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    sql`update wartung set text = ${"a".repeat(281)}, aktiv = true, seit = now()`,
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    sql`update wartung set text = 'x', aktiv = false`,
  ).rejects.toMatchObject({ code: "23514" });
  await expect(sql`update wartung set aktiv = true`).rejects.toMatchObject({
    code: "23514",
  });
});
