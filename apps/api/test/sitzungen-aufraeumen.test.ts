import { randomUUID } from "node:crypto";
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
import { erstelleDb } from "../src/db/client.js";
import {
  loescheAbgelaufeneSitzungen,
  starteSitzungenAufraeumen,
} from "../src/sitzungen-aufraeumen.js";
import { API_URL } from "./hilfen/datenbank.js";

const sql = postgres(API_URL);
// Eigener Client für Drizzle: drizzle() liefert Zeitpunkte seines Clients danach als Text
const db = erstelleDb(postgres(API_URL));
afterAll(() => Promise.all([sql.end(), db.$client.end()]));

const TAG = 24 * 60 * 60 * 1000;

// Eine Sitzung mit Push-Token, die `abstand` Millisekunden ab jetzt abläuft
async function sitzungMitToken(userId: string, abstand: number) {
  const [sitzung] = await sql`
    insert into session (token, expires_at, updated_at, user_id)
    values (${randomUUID()}, ${new Date(Date.now() + abstand)}, now(), ${userId})
    returning id`;
  await sql`
    insert into push_token (session_id, token, user_id, plattform)
    values (${sitzung.id}, ${`fcm-test-${randomUUID()}`}, ${userId}, 'ios')`;
  return sitzung.id as string;
}

test("eine abgelaufene Sitzung geht samt Push-Token, eine gültige bleibt", async () => {
  const [abteilung] =
    await sql`insert into abteilung (name) values ('Testabteilung') returning id`;
  const [person] = await sql`
    insert into "user" (name, email, abteilung_id)
    values ('Testperson', ${`${randomUUID()}@example.org`}, ${abteilung.id})
    returning id`;
  await sitzungMitToken(person.id, -60_000);
  const gueltig = await sitzungMitToken(person.id, 3_600_000);

  // Mindestens: Andere Testdateien laufen parallel auf derselben Datenbank
  expect(await loescheAbgelaufeneSitzungen(db)).toBeGreaterThanOrEqual(1);

  expect(
    await sql`select id from session where user_id = ${person.id}`,
  ).toEqual([{ id: gueltig }]);
  expect(
    await sql`select session_id from push_token where user_id = ${person.id}`,
  ).toEqual([{ session_id: gueltig }]);
});

describe("Timer", () => {
  let ausgabe: MockInstance<typeof console.log>;
  beforeEach(() => {
    vi.useFakeTimers();
    ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    ausgabe.mockRestore();
    vi.useRealTimers();
  });

  test("läuft sofort und dann alle 24 Stunden; das Log nennt nur die Anzahl", async () => {
    const lauf = vi.fn().mockResolvedValue(3);
    const timer = starteSitzungenAufraeumen(lauf);
    await vi.advanceTimersByTimeAsync(0);
    expect(lauf).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ausgabe.mock.calls[0][0] as string)).toEqual({
      zeit: expect.any(String),
      ereignis: "sitzungen",
      geloescht: 3,
    });
    await vi.advanceTimersByTimeAsync(TAG - 1);
    expect(lauf).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(lauf).toHaveBeenCalledTimes(2);
    clearInterval(timer);
  });

  test("ein Fehler schreibt nur seinen Code, und der Timer läuft weiter", async () => {
    const lauf = vi
      .fn()
      .mockRejectedValueOnce(
        // Die Meldung sieht aus wie eine Verbindungs-URL mit Passwort: Sie darf nie im Log stehen
        Object.assign(
          new Error("postgres://api:geheim-7@example.org/fireresponse"),
          {
            code: "ECONNREFUSED",
          },
        ),
      )
      .mockResolvedValue(0);
    const timer = starteSitzungenAufraeumen(lauf);
    await vi.advanceTimersByTimeAsync(0);
    const zeile = ausgabe.mock.calls[0][0] as string;
    expect(zeile).not.toContain("geheim-7");
    expect(JSON.parse(zeile)).toEqual({
      zeit: expect.any(String),
      ereignis: "sitzungen",
      code: "ECONNREFUSED",
    });

    await vi.advanceTimersByTimeAsync(TAG);
    expect(lauf).toHaveBeenCalledTimes(2);
    clearInterval(timer);
  });
});
