import { readFileSync } from "node:fs";
import { Hono } from "hono";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import {
  erstelleDrosselung,
  LIMIT_ALLGEMEIN,
  LIMIT_OEFFENTLICH,
} from "../src/drosselung.js";
import { ladeSeiten } from "../src/seiten.js";
import {
  bereiteAuthTestsVor,
  erstelleTestAuth,
  zufallsIp,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";

bereiteAuthTestsVor();

const sql = postgres(API_URL);
const db = erstelleDb(sql);
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth: erstelleTestAuth(db),
  seiten: ladeSeiten(),
});
afterAll(() => sql.end());

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

const holen = (pfad: string, ip?: string) =>
  app.request(pfad, { headers: ip ? { "X-Forwarded-For": ip } : {} });

describe("Drosselung", () => {
  test("zählt je Adresse, antwortet danach mit 429 und Wartezeit, und öffnet im nächsten Fenster wieder", () => {
    let t = 1_000_000;
    const mini = new Hono()
      .use(erstelleDrosselung(2, () => t))
      .get("/", (c) => c.text("ok"));
    const frage = (ip: string) =>
      mini.request("/", { headers: { "X-Forwarded-For": ip } });
    return (async () => {
      expect((await frage("a")).status).toBe(200);
      expect((await frage("a")).status).toBe(200);
      const zuviel = await frage("a");
      expect(zuviel.status).toBe(429);
      expect(await zuviel.json()).toMatchObject({ code: "ZU_VIELE_ANFRAGEN" });
      expect(zuviel.headers.get("x-retry-after")).toBe("60");
      // Eine andere Adresse zählt für sich
      expect((await frage("b")).status).toBe(200);
      t += 59_000;
      expect((await frage("a")).status).toBe(429);
      expect((await frage("a")).headers.get("x-retry-after")).toBe("1");
      t += 1_000;
      expect((await frage("a")).status).toBe(200);
    })();
  });

  test("nimmt die erste Adresse der Liste und zählt ohne Header nichts", async () => {
    const mini = new Hono()
      .use(erstelleDrosselung(1))
      .get("/", (c) => c.text("ok"));
    const mit = (kopf: string) =>
      mini.request("/", { headers: { "X-Forwarded-For": kopf } });
    expect((await mit("1.1.1.1, 9.9.9.9")).status).toBe(200);
    expect((await mit("1.1.1.1, 8.8.8.8")).status).toBe(429);
    for (let i = 0; i < 5; i++) {
      expect((await mini.request("/")).status).toBe(200);
    }
  });

  test.each([
    "/datenschutz",
    "/nutzungsbedingungen",
    "/konto-loeschen",
    "/support",
    "/api/v1/datenschutz",
  ])("GET %s: nach %i Anfragen je Minute kommt 429", async (pfad) => {
    // Ein Zähler für alle öffentlichen Pfade, darum eine eigene Adresse je Pfad und der Rest auf demselben Pfad
    const ip = zufallsIp();
    for (let i = 0; i < LIMIT_OEFFENTLICH; i++) {
      expect((await holen(pfad, ip)).status).toBe(200);
    }
    const antwort = await holen(pfad, ip);
    expect(antwort.status).toBe(429);
    expect(await antwort.json()).toMatchObject({ code: "ZU_VIELE_ANFRAGEN" });
    expect(antwort.headers.get("x-retry-after")).toMatch(/^\d+$/);
    // Sicherheits-Kopfzeilen und kein Cache auch auf dem 429
    expect(antwort.headers.get("cache-control")).toBe("no-store");
    expect(antwort.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("/api/v1 und /admin teilen einen grosszügigeren Zähler; /health bleibt frei", async () => {
    const ip = zufallsIp();
    for (let i = 0; i < LIMIT_ALLGEMEIN; i++) {
      // Ohne Sitzung antwortet /api/v1 mit 401
      expect((await holen("/api/v1/ich", ip)).status).toBe(401);
    }
    expect((await holen("/api/v1/ich", ip)).status).toBe(429);
    expect((await holen("/admin", ip)).status).toBe(429);
    // Andere Adresse unberührt, eigene Seiten und /health ebenfalls
    expect((await holen("/api/v1/ich", zufallsIp())).status).toBe(401);
    expect((await holen("/datenschutz", ip)).status).toBe(200);
    expect((await holen("/health", ip)).status).toBe(200);
  });
});

describe("Annahme: die API ist nur über den Edge-Caddy erreichbar", () => {
  // Das Limit zählt nach X-Forwarded-For; ein offener Port der API liesse es umgehen
  test("deploy/docker-compose.prod.yml veröffentlicht keinen Port", () => {
    const compose = readFileSync(
      new URL("../../../deploy/docker-compose.prod.yml", import.meta.url),
      "utf8",
    );
    expect(compose).not.toMatch(/^\s*ports:/m);
  });
});
