import { eq } from "drizzle-orm";
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
import { ladeSeiten } from "../src/seiten.js";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import {
  APP,
  bereiteAuthTestsVor,
  erstelleTestAuth,
  zufallsIp,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";

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

// Jede Anfrage schreibt sonst eine Log-Zeile in die Testausgabe
let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

// Bodys ohne Treffer: Der Name «x» scheitert vor jedem Hashing mit 422 (die Route macht daraus 401), die übrigen Pfade antworten ohne Cookie 401
const FAELLE: [string, number, Record<string, string>][] = [
  ["/sign-in/username", 30, { username: "x", password: "egal-egal-egal" }],
  [
    "/change-password",
    5,
    { currentPassword: "egal-egal-egal", newPassword: "egal-egal-egal-2" },
  ],
  ["/two-factor/verify-totp", 5, { code: "000000" }],
  ["/two-factor/verify-backup-code", 5, { code: "falsch-falsch" }],
];

function anfrage(pfad: string, body: Record<string, string>, ip: string) {
  return app.request(`/api/auth${pfad}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "expo-origin": APP,
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

describe("Rate-Limit pro Client-IP und Pfad, gezählt in rate_limit", () => {
  test.each(FAELLE)(
    "%s: die ersten %i Anfragen ohne 429, dann 429 mit eigener Meldung; ein zweiter Client zählt getrennt",
    async (pfad, max, body) => {
      const clientA = zufallsIp();
      const clientB = zufallsIp();
      for (let i = 1; i <= max; i++) {
        const antwort = await anfrage(pfad, body, clientA);
        expect(antwort.status, `Anfrage ${i}`).toBe(401);
      }

      const gebremst = await anfrage(pfad, body, clientA);
      expect(gebremst.status).toBe(429);
      expect(await gebremst.json()).toEqual({
        code: "ZU_VIELE_ANFRAGEN",
        message: "Zu viele Anfragen. Bitte später nochmals versuchen.",
      });
      expect(Number(gebremst.headers.get("X-Retry-After"))).toBeGreaterThan(0);

      expect((await anfrage(pfad, body, clientB)).status).toBe(401);

      // Der Schlüssel ist IP und Pfad; die abgewiesene Anfrage zählt nicht weiter
      const schluessel = `${clientA}|${pfad}`;
      const [zeile] = await db
        .select()
        .from(schema.rateLimit)
        .where(eq(schema.rateLimit.key, schluessel));
      expect(zeile.count).toBe(max);

      // Eine Minute später (last_request zurückgestellt statt Zeit vorgespult): noch gesperrt, das Fenster ist 15 Minuten
      await db
        .update(schema.rateLimit)
        .set({ lastRequest: zeile.lastRequest - 60_000 })
        .where(eq(schema.rateLimit.key, schluessel));
      expect((await anfrage(pfad, body, clientA)).status).toBe(429);
    },
  );
});
