import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { erstelleDb } from "../src/db/client.js";
import {
  APP,
  bereiteAuthTestsVor,
  cookiesAus,
  erstelleTestAuth,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  type PersonaKonto,
} from "./hilfen/personas.js";

bereiteAuthTestsVor();
// bereiteAuthTestsVor setzt nur testTimeout; das beforeAll rechnet scrypt für jede Persona
vi.setConfig({ hookTimeout: 120_000 });

const sql = postgres(API_URL);
// Eigener Client für Drizzle: drizzle() liefert Zeitpunkte seines Clients danach als Text
const db = erstelleDb(postgres(API_URL));
const auth = erstelleTestAuth(db);

// Anmeldung wie der Expo-Client; über auth.api, das keine Herkunft prüft
async function anmelden(konto: PersonaKonto) {
  const anmeldung = await auth.api.signInUsername({
    body: { username: konto.benutzername!, password: konto.passwort! },
    returnHeaders: true,
  });
  return { "expo-origin": APP, cookie: cookiesAus(anmeldung) };
}

let admin: PersonaKonto;
let elternA: PersonaKonto;
let zweitesGeraet: Record<string, string>;

beforeAll(async () => {
  const welt = await erstelleWelt(db, auth);
  admin = await legePersonaAn(welt, "admin");
  elternA = await legePersonaAn(welt, "elternA");
  zweitesGeraet = await anmelden(elternA);
});
afterAll(() => Promise.all([sql.end(), db.$client.end()]));

test("nach der CLI gilt keine Sitzung mehr", async () => {
  // Vorher gilt jede der drei Sitzungen
  const sitzungen: [Record<string, string>, string | null][] = [
    [admin.headers, admin.id],
    [elternA.headers, elternA.id],
    [zweitesGeraet, elternA.id],
  ];
  for (const [headers, id] of sitzungen) {
    const sitzung = await auth.api.getSession({ headers });
    expect(sitzung?.user.id).toBe(id);
  }
  const [{ n }] = await sql`select count(*)::int as n from session`;
  expect(n).toBeGreaterThanOrEqual(3);

  const ergebnis = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli/sitzungen-beenden.ts"],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, DATABASE_URL: API_URL },
      encoding: "utf8",
      // Auf einem ausgelasteten Rechner startet tsx ein Vielfaches langsamer
      timeout: 60_000,
    },
  );
  expect(ergebnis.status).toBe(0);
  expect(ergebnis.stdout).toBe(`Beendete Sitzungen: ${n}\n`);

  // Danach gilt keine Sitzung mehr, auch keine aus den anderen Testdateien
  for (const [headers] of sitzungen) {
    expect(await auth.api.getSession({ headers })).toBeNull();
  }
  expect(await sql`select 1 from session`).toHaveLength(0);

  // Konten, Passwörter und Faktoren bleiben: Die Anmeldung gelingt wieder
  const neu = await auth.api.getSession({ headers: await anmelden(elternA) });
  expect(neu?.user.id).toBe(elternA.id);
});

test("«sitzungen:beenden» in package.json startet genau diese Datei", () => {
  const paket = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  expect(paket.scripts["sitzungen:beenden"]).toBe(
    "tsx --env-file-if-exists=.env src/cli/sitzungen-beenden.ts",
  );
});
