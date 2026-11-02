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
import { zurueckgerollt } from "./transaktion.js";

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

  // Jede Einheit in der Transaktion, die zurückrollt: Andere Testdateien rufen /health auf und dürfen die Zeilen nie sehen
  test("meldet «sync-veraltet», wenn der Sync einer Einheit seit einer Stunde nicht gelang", async () => {
    await zurueckgerollt(sql, async (tx) => {
      const [bezirk] =
        await tx`insert into bezirk (name) values (${`Health ${Date.now()}`}) returning id`;
      const [einheit] =
        await tx`insert into einheit (bezirk_id, typ, name, lodur_url_verschluesselt, sync_ok_am)
        values (${bezirk!.id}, 'jf', 'Health', 'x', now() - interval '61 minutes') returning id`;
      const gesund = async () => {
        const res = await health(tx as unknown as Sql);
        return [res.status, await res.text()];
      };
      expect(await gesund()).toEqual([503, "sync-veraltet"]);
      // Nur der Code im Log, weder Einheit noch Link
      expect(logEintraege().find((e) => e.ereignis === "health")).toMatchObject(
        {
          ereignis: "health",
          code: "sync-veraltet",
        },
      );
      expect(JSON.stringify(logEintraege())).not.toContain(einheit!.id);

      await tx`update einheit set sync_ok_am = now() - interval '59 minutes' where id = ${einheit!.id}`;
      expect(await gesund()).toEqual([200, "ok"]);

      // Vor dem ersten Erfolg zählt der Zeitpunkt, an dem der Link eingetragen wurde
      await tx`update einheit set sync_ok_am = null, lodur_url_gesetzt_am = now() - interval '61 minutes' where id = ${einheit!.id}`;
      expect(await gesund()).toEqual([503, "sync-veraltet"]);
      await tx`update einheit set lodur_url_gesetzt_am = now() where id = ${einheit!.id}`;
      expect(await gesund()).toEqual([200, "ok"]);

      // Ohne Link gibt es nichts zu synchronisieren
      await tx`update einheit set lodur_url_verschluesselt = null, sync_ok_am = now() - interval '5 days' where id = ${einheit!.id}`;
      expect(await gesund()).toEqual([200, "ok"]);
    });
  });
});
