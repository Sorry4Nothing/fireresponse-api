import { readFileSync } from "node:fs";
import { HTTPException } from "hono/http-exception";
import { testClient } from "hono/testing";
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
import { ladeSeiten } from "../src/seiten.js";
import { erstelleTestAuth } from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NICHT_GEFUNDEN = { code: "NICHT_GEFUNDEN", message: "Nicht gefunden" };

const sql = postgres(API_URL);
const db = erstelleDb(sql);
const auth = erstelleTestAuth(db);
afterAll(() => sql.end());

// Erfundener Name in spitzen Klammern: Windows verbietet sie in Pfaden, Datei-URLs kodieren sie; so trifft die Suche nicht den Pfad zum Checkout in den Zeilen des Stacks
const NAME = "<Max Muster>";

// Eine Meldung, die Eingaben wiederholt, kann mehrzeilig sein und wie eine Zeile des Stacks aussehen
const ECHO = `${NAME} 203.0.113.7\n    at ${NAME} 203.0.113.7`;

// Testrouten, angehängt wie später die Routen der Issues; unter /api/ statt /api/v1/, weil dort personAusSitzung eine Sitzung verlangt
const app = () =>
  erstelleApp({
    appMinVersion: "1.2.0",
    sql,
    db,
    auth,
    seiten: ladeSeiten(),
  })
    .post("/api/test/:token", async (c) => c.json(await c.req.json()))
    .get("/api/kaputt", () => {
      const fehler = new Error(ECHO);
      // Node bildet den Kopf des Stacks ohne dieses eigene toString
      fehler.toString = () => "Error";
      throw fehler;
    })
    .get("/api/uuid", async (c) => {
      // Postgres wiederholt die Eingabe in der Meldung
      await sql`select ${ECHO}::uuid`;
      return c.text("nie");
    })
    .get("/api/konflikt", () => {
      throw new HTTPException(409, { message: "Max Muster gibt es schon" });
    })
    .get("/api/gesperrt", () => {
      // 422 hat keinen Eintrag in der Fehlertabelle
      throw new HTTPException(422, { res: new Response("Max Muster") });
    });

// Erfundene Daten überall, wo ein Client etwas hinschreiben kann; nichts davon darf ins Log
const KOPFZEILEN = {
  Cookie: "better-auth.session_token=geheimes-token-1",
  Authorization: "Bearer geheimes-token-2",
  "X-Forwarded-For": "203.0.113.7",
  // Nur Zeichen, die Hono als ID übernehmen würde; dass die ID nicht übernommen wird, prüft der Vergleich mit der UUID
  "X-Request-Id": "max-muster",
  "User-Agent": `${NAME} Telefon/1.0`,
};
const VERBOTEN = [NAME.toLowerCase(), "geheimes-token", "203.0.113.7"];

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

// Jede Zeile ist JSON mit Request-ID und ohne die erfundenen Daten
function logEintraege(...auchVerboten: string[]) {
  return ausgabe.mock.calls.map(([zeile]) => {
    expect(zeile).toBeTypeOf("string");
    for (const wert of [...VERBOTEN, ...auchVerboten]) {
      expect(zeile.toLowerCase()).not.toContain(wert);
    }
    const eintrag = JSON.parse(zeile);
    expect(eintrag.requestId).toMatch(UUID);
    return eintrag;
  });
}

describe("Log", () => {
  test("ein Eintrag pro Anfrage, mit Request-ID, ohne Personendaten und ohne IP-Adresse", async () => {
    const res = await app().request(
      `/api/test/geheimes-token-3?name=${encodeURIComponent(NAME)}`,
      {
        method: "POST",
        headers: { ...KOPFZEILEN, "Content-Type": "application/json" },
        body: JSON.stringify({ name: NAME, nachricht: `Hallo ${NAME}` }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.has("X-Request-Id")).toBe(false);
    expect(logEintraege()).toEqual([
      {
        zeit: expect.any(String),
        requestId: expect.any(String),
        methode: "POST",
        route: "/api/test/:token",
        status: 200,
        dauerMs: expect.any(Number),
      },
    ]);
  });

  test("jede Anfrage bekommt eine eigene Request-ID", async () => {
    const instanz = app();
    await instanz.request("/unbekannt");
    await instanz.request("/unbekannt");
    const [erste, zweite] = logEintraege();
    expect(erste.requestId).not.toBe(zweite.requestId);
  });
});

describe("/health", () => {
  test("meldet «ok», wenn die Datenbank antwortet", async () => {
    const res = await testClient(app()).health.$get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("meldet ohne Details «fehler», wenn die Datenbank nicht antwortet", async () => {
    // Schon beendet: Die Abfrage scheitert sofort, ohne Netz
    const tot = postgres("postgres://postgres@127.0.0.1:1/fireresponse");
    await tot.end();
    // db und auth aus dem Modul: Die Route /health berührt beide nie
    const res = await testClient(
      erstelleApp({
        appMinVersion: "1.2.0",
        sql: tot,
        db,
        auth,
        seiten: ladeSeiten(),
      }),
    ).health.$get(undefined, { headers: KOPFZEILEN });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("fehler");
    // postgres-js nennt Host und Port in message, address und port, darum nur der Code
    const [health, anfrage] = logEintraege("127.0.0.1");
    expect(health).toEqual({
      zeit: expect.any(String),
      requestId: anfrage.requestId,
      ereignis: "health",
      code: "CONNECTION_ENDED",
    });
    expect(anfrage).toMatchObject({ route: "/health", status: 503 });
  });

  test("liegt ausserhalb der Versionsprüfung", async () => {
    const res = await testClient(app()).health.$get(undefined, {
      headers: { "X-App-Version": "0.0.1" },
    });
    expect(res.status).toBe(200);
  });
});

describe("X-App-Version mit APP_MIN_VERSION 1.2.0", () => {
  test.each(["1.1.9", "abc", "1.2", "1.2.0-beta"])(
    "«%s»: 426",
    async (version) => {
      const res = await app().request("/api/unbekannt", {
        headers: { "X-App-Version": version },
      });
      expect(res.status).toBe(426);
      expect(await res.json()).toEqual({
        code: "APP_VERALTET",
        message: "Bitte App aktualisieren",
      });
      expect(logEintraege()).toMatchObject([{ status: 426 }]);
    },
  );

  test.each([
    ["«1.2.0»", { "X-App-Version": "1.2.0" }],
    ["«1.10.0»", { "X-App-Version": "1.10.0" }],
    ["ohne Header", {}],
  ])("%s: weiter zur Route", async (_, headers) => {
    const res = await app().request("/api/unbekannt", { headers });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NICHT_GEFUNDEN);
  });
});

describe("Fehler im einheitlichen Format", () => {
  test("unbekannter Pfad: 404", async () => {
    const res = await app().request("/unbekannt");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NICHT_GEFUNDEN);
  });

  test("Body über 64 KiB: 413, auch ohne passende Route", async () => {
    const sende = (bytes: number) =>
      app().request("/api/unbekannt", {
        method: "POST",
        body: "x".repeat(bytes),
      });
    expect((await sende(64 * 1024)).status).toBe(404);
    const res = await sende(70_000);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      code: "ZU_GROSS",
      message: "Anfrage zu gross",
    });
    expect(logEintraege()).toMatchObject([{ status: 404 }, { status: 413 }]);
  });

  test("Fehler im Handler: 500 ohne Meldung, im Log nur Name und Stack", async () => {
    const res = await app().request("/api/kaputt", { headers: KOPFZEILEN });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      code: "INTERNER_FEHLER",
      message: "Interner Fehler",
    });
    const [fehler, anfrage] = logEintraege();
    expect(fehler).toEqual({
      zeit: expect.any(String),
      requestId: anfrage.requestId,
      ereignis: "fehler",
      name: "Error",
      stack: expect.any(Array),
    });
    expect(fehler.stack.length).toBeGreaterThan(0);
    for (const zeile of fehler.stack) expect(zeile).toMatch(/^\s*at /);
    expect(anfrage).toMatchObject({ route: "/api/kaputt", status: 500 });
  });

  test("Fehler aus Postgres: im Log der Code, nie die Meldung mit der Eingabe", async () => {
    const res = await app().request("/api/uuid");
    expect(res.status).toBe(500);
    const [fehler] = logEintraege();
    expect(fehler).toMatchObject({
      ereignis: "fehler",
      name: "PostgresError",
      code: "22P02",
    });
  });

  test.each([
    ["/api/konflikt", 409],
    ["/api/gesperrt", 422],
  ])(
    "HTTPException ohne eigenen Eintrag (%s): Status bleibt, Text allgemein",
    async (pfad, status) => {
      const res = await app().request(pfad);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({
        code: "FEHLER",
        message: "Anfrage fehlgeschlagen",
      });
    },
  );
});

test("hono ist in der API exakt gepinnt", () => {
  const { dependencies } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  expect(dependencies.hono).toMatch(/^\d+\.\d+\.\d+$/);
});
