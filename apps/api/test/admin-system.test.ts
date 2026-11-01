import { randomUUID } from "node:crypto";
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
import { ladeSeiten } from "../src/seiten.js";
import { bereiteAuthTestsVor, erstelleTestAuth } from "./hilfen/auth.js";
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
afterAll(() => sql.end());

let welt: Welt;
let admin: PersonaKonto;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  admin = await legePersonaAn(welt, "kantonsadmin");
});

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

const hole = (konto: PersonaKonto, pfad: string) =>
  app.request(pfad, { headers: konto.headers });

describe("GET /api/v1/admin/system", () => {
  test("liefert Prozess, Datenbank, Bestand und Umgebung", async () => {
    const antwort = await hole(admin, "/api/v1/admin/system");
    expect(antwort.status).toBe(200);
    const daten = await antwort.json();
    expect(Object.keys(daten).sort()).toEqual([
      "bestand",
      "datenbank",
      "prozess",
      "umgebung",
    ]);
    expect(daten.prozess.node).toBe(process.version);
    expect(daten.prozess.laufzeitSekunden).toBeGreaterThanOrEqual(0);
    expect(daten.prozess.rssMb).toBeGreaterThan(0);
    expect(daten.datenbank.erreichbar).toBe(true);
    expect(daten.datenbank.pingMs).toBeGreaterThanOrEqual(0);
    expect(daten.datenbank.poolMaximum).toBeGreaterThan(0);
    // Der Admin selbst ist aktiv; Teilnehmende und Tokens zählt die Route über alle Einheiten
    expect(daten.bestand.aktivePersonen).toBeGreaterThanOrEqual(1);
    expect(daten.bestand.pushTokens).toBeGreaterThanOrEqual(0);
  });

  test("enthält keine Umgebungswerte, Hosts, Adressen oder Schlüssel", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://geheim:geheim@db.example.org/x");
    vi.stubEnv("BETTER_AUTH_SECRET", "geheimes-geheimnis-geheimes-geheimnis");
    vi.stubEnv("COMMIT_SHA", "kein Hash; <script>");
    try {
      const antwort = await hole(admin, "/api/v1/admin/system");
      const text = await antwort.text();
      for (const verboten of [
        "geheim",
        "db.example.org",
        "postgres://",
        "kein Hash",
        "localhost",
        "fireresponse.invalid",
        "example.org",
      ]) {
        expect(text).not.toContain(verboten);
      }
      const daten = JSON.parse(text);
      expect(daten.prozess.commit).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("ein gültiger Commit-Hash erscheint, sonst nichts", async () => {
    vi.stubEnv("COMMIT_SHA", "0123abc");
    try {
      const daten = await (await hole(admin, "/api/v1/admin/system")).json();
      expect(daten.prozess.commit).toBe("0123abc");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("GET /api/v1/admin/system/requests", () => {
  test("zählt Anfragen nach Routenmuster, nie nach konkretem Pfad", async () => {
    const id = randomUUID();
    // 404 für eine unbekannte Einheit: ein Fehler mit der ID im Pfad
    const fehler = await hole(
      admin,
      `/api/v1/admin/einheiten/${id}/zeitregeln`,
    );
    expect(fehler.status).toBe(404);
    expect((await hole(admin, "/api/v1/ich")).status).toBe(200);

    const antwort = await hole(admin, "/api/v1/admin/system/requests");
    expect(antwort.status).toBe(200);
    const text = await antwort.text();
    expect(text).not.toContain(id);
    const daten = JSON.parse(text);
    expect(daten.gesamt).toBeGreaterThanOrEqual(2);
    expect(daten.statusklassen["4xx"]).toBeGreaterThanOrEqual(1);
    expect(daten.stunden).toHaveLength(24);
    expect(daten.minuten).toHaveLength(60);
    const muster = daten.routen.map(
      (r: { methode: string; route: string }) => `${r.methode} ${r.route}`,
    );
    expect(muster).toContain(
      "GET /api/v1/admin/einheiten/:einheitId/zeitregeln",
    );
    expect(muster).toContain("GET /api/v1/ich");
    expect(daten.letzteFehler[0]).toEqual({
      zeit: expect.any(String),
      methode: "GET",
      route: "/api/v1/admin/einheiten/:einheitId/zeitregeln",
      status: 404,
    });
  });

  test("die Abrufe der System-Routen zählen nicht mit", async () => {
    await hole(admin, "/api/v1/admin/system");
    await hole(admin, "/api/v1/admin/system/requests");
    const daten = await (
      await hole(admin, "/api/v1/admin/system/requests")
    ).json();
    expect(
      daten.routen.filter((r: { route: string }) =>
        r.route.startsWith("/api/v1/admin/system"),
      ),
    ).toEqual([]);
  });

  test("statische Dateien der Verwaltung zählen nicht mit", async () => {
    await app.request("/admin/admin.css");
    const daten = await (
      await hole(admin, "/api/v1/admin/system/requests")
    ).json();
    expect(
      daten.routen.filter((r: { route: string }) =>
        r.route.startsWith("/admin"),
      ),
    ).toEqual([]);
  });

  test("Query und Header gelangen nicht in die Zahlen", async () => {
    const geheim = `tok-${randomUUID()}`;
    await app.request(`/api/v1/stufen?token=${geheim}`, {
      headers: { ...admin.headers, "x-geheim": geheim },
    });
    const text = await (
      await hole(admin, "/api/v1/admin/system/requests")
    ).text();
    expect(text).not.toContain(geheim);
  });

  test("Nicht-Admins bekommen 403, ohne Login 401", async () => {
    const eltern = await legePersonaAn(welt, "elternJfA");
    const ohne = await legePersonaAn(welt, "ohneLogin");
    for (const pfad of [
      "/api/v1/admin/system",
      "/api/v1/admin/system/requests",
    ]) {
      expect((await hole(eltern, pfad)).status).toBe(403);
      expect((await hole(ohne, pfad)).status).toBe(401);
    }
  });
});
