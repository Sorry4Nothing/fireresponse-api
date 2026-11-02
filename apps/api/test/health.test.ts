import { testClient } from "hono/testing";
import postgres, { type Sql } from "postgres";
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

const sql = postgres(API_URL);
const db = erstelleDb(sql);
const auth = erstelleTestAuth(db);
afterAll(() => sql.end());

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

function logEintraege() {
  return ausgabe.mock.calls.map(([zeile]) => JSON.parse(zeile as string));
}

function health(verbindung: Sql = sql) {
  return testClient(
    erstelleApp({
      appMinVersion: "1.2.0",
      sql: verbindung,
      db,
      auth,
      seiten: ladeSeiten(),
    }),
  ).health.$get();
}

describe("/health", () => {
  test("meldet «ok», wenn die Datenbank antwortet, und füllt das Log nicht", async () => {
    const res = await health();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(logEintraege()).toEqual([]);
  });

  test("meldet «fehler» ohne Datenbank, der Grund steht nur als Code im Log", async () => {
    const tot = postgres(API_URL, { max: 1 });
    await tot.end();
    const res = await health(tot);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("fehler");
    const [grund] = logEintraege();
    expect(grund).toMatchObject({ ereignis: "health" });
    expect(JSON.stringify(grund)).not.toContain("localhost");
  });
});
