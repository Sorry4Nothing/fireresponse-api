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
import { APP, bereiteAuthTestsVor, erstelleTestAuth } from "./hilfen/auth.js";
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
// Wie in test/app.test.ts: eine Testroute für den Fehler im Handler
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  seiten: ladeSeiten(),
}).get("/api/kaputt", () => {
  throw new Error("kaputt");
});

// bereiteAuthTestsVor setzt BETTER_AUTH_URL auf diese Adresse
const EIGENE_HERKUNFT = "https://fireresponse.invalid";
const KEINE_BERECHTIGUNG = {
  code: "KEINE_BERECHTIGUNG",
  message: "Keine Berechtigung",
};

let welt: Welt;
let eltern: PersonaKonto;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  eltern = await legePersonaAn(welt, "elternA");
});
afterAll(() => sql.end());

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

// Nur die Zeilen des Anfrage-Logs, ohne die von better-auth und die der Fehler
const anfragen = () =>
  ausgabe.mock.calls
    .map(([zeile]) => JSON.parse(zeile))
    .filter((eintrag) => "status" in eintrag);

describe("Sicherheits-Kopfzeilen (#220)", () => {
  const kopfzeilen = (antwort: Response) => ({
    nosniff: antwort.headers.get("x-content-type-options"),
    referrer: antwort.headers.get("referrer-policy"),
    csp: antwort.headers.get("content-security-policy"),
    cache: antwort.headers.get("cache-control"),
  });

  test.each([
    ["ohne Sitzung", "/api/v1/stufen", 401],
    ["unbekannter Pfad", "/unbekannt", 404],
    ["Fehler im Handler", "/api/kaputt", 500],
  ])("JSON %s (%s): alle Kopfzeilen und no-store", async (_, pfad, status) => {
    const antwort = await app.request(pfad);
    expect(antwort.status).toBe(status);
    expect(kopfzeilen(antwort)).toEqual({
      nosniff: "nosniff",
      referrer: "no-referrer",
      csp: "frame-ancestors 'none'",
      cache: "no-store",
    });
  });

  test("JSON einer Route mit Sitzung: dieselben Kopfzeilen", async () => {
    const antwort = await app.request("/api/v1/ich", {
      headers: eltern.headers,
    });
    expect(antwort.status).toBe(200);
    expect(kopfzeilen(antwort)).toEqual({
      nosniff: "nosniff",
      referrer: "no-referrer",
      csp: "frame-ancestors 'none'",
      cache: "no-store",
    });
  });

  test.each(["/datenschutz", "/health"])(
    "%s: die Kopfzeilen, aber kein no-store, weil kein JSON",
    async (pfad) => {
      const antwort = await app.request(pfad);
      expect(kopfzeilen(antwort)).toEqual({
        nosniff: "nosniff",
        referrer: "no-referrer",
        csp: "frame-ancestors 'none'",
        cache: null,
      });
    },
  );

  test("die Verwaltung behält ihre eigene CSP", async () => {
    const antwort = await app.request("/admin");
    expect(antwort.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
  });
});

describe("Origin bei ändernden Routen unter /api/v1 (#221)", () => {
  // Ungültiger Body: Wer an der Prüfung vorbeikommt, bekommt 400 von der Route
  const melden = (headers: Record<string, string>) =>
    app.request("/api/v1/push-token", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ token: "zu-kurz", plattform: "ios" }),
    });

  test.each([
    ["fremde Herkunft", "https://boese.example.org"],
    ["andere Subdomain", "https://neben.fireresponse.invalid"],
    ["eigener Host über http", "http://fireresponse.invalid"],
    ["«null»", "null"],
  ])("%s: 403, auch mit Sitzung", async (_, herkunft) => {
    const antwort = await melden({ ...eltern.headers, origin: herkunft });
    expect(antwort.status).toBe(403);
    expect(await antwort.json()).toEqual(KEINE_BERECHTIGUNG);
  });

  test.each([
    ["eigene Herkunft", { origin: EIGENE_HERKUNFT }],
    ["App-Schema", { origin: APP }],
    ["ohne Origin wie die App", {}],
  ])("%s: weiter zur Route", async (_, kopf) => {
    const antwort = await melden({ ...eltern.headers, ...kopf });
    expect(antwort.status).toBe(400);
  });

  test("ohne Sitzung: fremde Herkunft 403, eigene 401", async () => {
    expect((await melden({ origin: "https://boese.example.org" })).status).toBe(
      403,
    );
    expect((await melden({ origin: EIGENE_HERKUNFT })).status).toBe(401);
  });

  test("lesende Anfragen prüft der Origin nicht", async () => {
    const antwort = await app.request("/api/v1/ich", {
      headers: { ...eltern.headers, origin: "https://boese.example.org" },
    });
    expect(antwort.status).toBe(200);
  });
});

describe("Nutzer-ID im Anfrage-Log (#224)", () => {
  test("403 einer angemeldeten Anfrage: die ID, kein weiteres Feld", async () => {
    const konto = await legePersonaAn(welt, "mussPasswortAendern");
    const antwort = await app.request("/api/v1/programme", {
      headers: konto.headers,
    });
    expect(antwort.status).toBe(403);
    expect(anfragen()).toEqual([
      {
        zeit: expect.any(String),
        requestId: expect.any(String),
        methode: "GET",
        route: expect.any(String),
        status: 403,
        dauerMs: expect.any(Number),
        nutzerId: konto.id,
      },
    ]);
  });

  test("200 mit Sitzung und 401 ohne Sitzung: keine ID im Log", async () => {
    await app.request("/api/v1/ich", { headers: eltern.headers });
    await app.request("/api/v1/ich");
    const [erfolg, ohneSitzung] = anfragen();
    expect(erfolg.status).toBe(200);
    expect(ohneSitzung.status).toBe(401);
    expect(erfolg).not.toHaveProperty("nutzerId");
    expect(ohneSitzung).not.toHaveProperty("nutzerId");
  });

  test("403 wegen fremder Herkunft: ohne ID, die Sitzung ist noch nicht gelesen", async () => {
    await app.request("/api/v1/push-token", {
      method: "PUT",
      headers: { ...eltern.headers, origin: "https://boese.example.org" },
    });
    const [eintrag] = anfragen();
    expect(eintrag.status).toBe(403);
    expect(eintrag).not.toHaveProperty("nutzerId");
  });
});
