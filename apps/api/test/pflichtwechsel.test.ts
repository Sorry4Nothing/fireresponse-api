import { randomUUID } from "node:crypto";
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
import { ladeSeiten } from "../src/seiten.js";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import {
  erzeugeStartpasswort,
  normalisiereStartpasswort,
  startpasswortFelder,
} from "../src/startpasswort.js";
import {
  APP,
  bereiteAuthTestsVor,
  cookiesAus,
  erstelleTestAuth,
  GELEAKT,
  zufallsIp,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import { erstelleWelt, legePersonaAn, type Welt } from "./hilfen/personas.js";

bereiteAuthTestsVor();

const sql = postgres(API_URL);
const db = erstelleDb(sql);
const auth = erstelleTestAuth(db);
// Testrouten wie die späteren Issues: eine gesperrte und die eine Ausnahme GET /api/v1/ich
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  seiten: ladeSeiten(),
})
  .get("/api/v1/ich", (c) => c.json({ id: c.get("person").id }))
  .get("/api/v1/test/geheim", (c) => c.json({ ok: true }));
afterAll(() => sql.end());

const NEU = "nur-fuer-tests-2";

let welt: Welt;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
});

// Jede Anfrage schreibt sonst eine Log-Zeile in die Testausgabe
let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

// POST an better-auth durch die App, mit den Kopfzeilen der Persona
function post(
  pfad: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
) {
  return app.request(`/api/auth/${pfad}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Sperre, solange mussPasswortAendern gesetzt ist", () => {
  test("GET /api/v1/ich antwortet 200, jede andere /api/v1-Route 403; ohne Flag geht beides", async () => {
    const offen = await legePersonaAn(welt, "mussPasswortAendern");
    const gewechselt = await legePersonaAn(welt, "elternA");

    expect(
      (await app.request("/api/v1/ich", { headers: offen.headers })).status,
    ).toBe(200);
    const gesperrt = await app.request("/api/v1/test/geheim", {
      headers: offen.headers,
    });
    expect(gesperrt.status).toBe(403);
    expect(await gesperrt.json()).toEqual({
      code: "KEINE_BERECHTIGUNG",
      message: "Keine Berechtigung",
    });

    for (const pfad of ["/api/v1/ich", "/api/v1/test/geheim"]) {
      expect(
        (await app.request(pfad, { headers: gewechselt.headers })).status,
      ).toBe(200);
    }
  });
});

describe("Pflichtwechsel über change-password", () => {
  test("ein neues Passwort mit 11 Zeichen liefert 400", async () => {
    const konto = await legePersonaAn(welt, "mussPasswortAendern");
    const antwort = await post("change-password", konto.headers, {
      currentPassword: konto.passwort,
      newPassword: "elf-zeichen",
    });
    expect(antwort.status).toBe(400);
    expect((await antwort.json()).code).toBe("PASSWORD_TOO_SHORT");
  });

  test("12 Zeichen ohne Zeichenregeln gehen: «abcdefghijkl» wird angenommen", async () => {
    const konto = await legePersonaAn(welt, "mussPasswortAendern");
    const antwort = await post("change-password", konto.headers, {
      currentPassword: konto.passwort,
      newPassword: "abcdefghijkl",
    });
    expect(antwort.status).toBe(200);
  });

  test("das Startpasswort in Kleinbuchstaben als neues Passwort liefert 400 PASSWORT_UNVERAENDERT", async () => {
    const konto = await legePersonaAn(welt, "mussPasswortAendern");
    const antwort = await post("change-password", konto.headers, {
      currentPassword: konto.passwort,
      newPassword: konto.passwort!.toLowerCase(),
    });
    expect(antwort.status).toBe(400);
    expect(await antwort.json()).toMatchObject({
      code: "PASSWORT_UNVERAENDERT",
    });
  });

  test("ein Passwort aus einem bekannten Datenleck liefert 400 PASSWORD_COMPROMISED", async () => {
    const konto = await legePersonaAn(welt, "mussPasswortAendern");
    const antwort = await post("change-password", konto.headers, {
      currentPassword: konto.passwort,
      newPassword: GELEAKT,
    });
    expect(antwort.status).toBe(400);
    expect((await antwort.json()).code).toBe("PASSWORD_COMPROMISED");
  });

  test("nach dem Wechsel: Flag weg, die andere Sitzung endet, die neue Sitzung erreicht /api/v1, das Startpasswort gilt nicht mehr", async () => {
    const konto = await legePersonaAn(welt, "mussPasswortAendern");
    const zweite = await auth.api.signInUsername({
      body: { username: konto.benutzername!, password: konto.passwort! },
      returnHeaders: true,
    });
    const zweitesCookie = cookiesAus(zweite);

    const antwort = await post("change-password", konto.headers, {
      currentPassword: konto.passwort,
      newPassword: NEU,
    });
    expect(antwort.status).toBe(200);
    const neuesCookie = cookiesAus(antwort);
    expect(neuesCookie).toContain("session_token");

    const [zeile] = await db
      .select({ flag: schema.user.mussPasswortAendern })
      .from(schema.user)
      .where(eq(schema.user.id, konto.id!));
    expect(zeile.flag).toBe(false);
    expect(
      await auth.api.getSession({ headers: { cookie: zweitesCookie } }),
    ).toBeNull();

    const frei = await app.request("/api/v1/test/geheim", {
      headers: { ...konto.headers, cookie: neuesCookie },
    });
    expect(frei.status).toBe(200);

    // Das Startpasswort gilt nicht mehr: ohne Flag kein normalisierter Vergleich, und der Hash ist neu
    const alt = await post("sign-in/username", konto.headers, {
      username: konto.benutzername,
      password: konto.passwort,
    });
    expect(alt.status).toBe(401);
  });

  test("two-factor/enable eines Admins mit offenem Startpasswort nimmt das Startpasswort in Kleinbuchstaben an", async () => {
    const startpasswort = erzeugeStartpasswort();
    const benutzername = `admin.offen.${randomUUID().slice(0, 8)}`;
    await auth.api.createUser({
      body: {
        email: `${randomUUID()}@example.org`,
        password: normalisiereStartpasswort(startpasswort),
        name: "Admin mit offenem Startpasswort",
        role: "admin",
        data: {
          username: benutzername,
          abteilungId: welt.testabteilungId,
          ...startpasswortFelder(),
        },
      },
    });
    const anmeldung = await auth.api.signInUsername({
      body: { username: benutzername, password: startpasswort },
      returnHeaders: true,
    });
    const headers = {
      "expo-origin": APP,
      "x-forwarded-for": zufallsIp(),
      cookie: cookiesAus(anmeldung),
    };
    const antwort = await post("two-factor/enable", headers, {
      password: startpasswort.toLowerCase(),
    });
    expect(antwort.status).toBe(200);
    expect(await antwort.json()).toMatchObject({
      totpURI: expect.any(String),
      backupCodes: expect.any(Array),
    });
  });
});
