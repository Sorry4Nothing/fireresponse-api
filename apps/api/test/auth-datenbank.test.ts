import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, expect, test } from "vitest";
import { erstelleDb } from "../src/db/client.js";
import {
  erzeugeStartpasswort,
  normalisiereStartpasswort,
} from "../src/startpasswort.js";
import {
  bereiteAuthTestsVor,
  erstelleTestAuth,
  zufallsIp,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";

bereiteAuthTestsVor();

const TAG = 86_400_000;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const sql = postgres(API_URL);
// Eigener Client für Drizzle: drizzle() liefert Zeitpunkte seines Clients danach als Text
const db = erstelleDb(postgres(API_URL));
const auth = erstelleTestAuth(db);

afterAll(() => Promise.all([sql.end(), db.$client.end()]));

// Ohne mussPasswortAendern: Es gilt der Standardwert der Datenbank, darum ein künftiges Ablaufdatum und ein Startpasswort (der Hook vergleicht normalisiert)
async function legeAn() {
  const benutzername = `test${randomUUID().slice(0, 8)}`;
  const startpasswort = erzeugeStartpasswort();
  const { user } = await auth.api.createUser({
    body: {
      email: `${randomUUID()}@example.org`,
      password: normalisiereStartpasswort(startpasswort),
      name: "Testperson",
      data: {
        username: benutzername,
        startpasswortGueltigBis: new Date(Date.now() + 7 * TAG),
      },
    },
  });
  return { id: user.id, benutzername, startpasswort };
}

function anmelden(benutzername: string, startpasswort: string) {
  return auth.handler(
    new Request("https://fireresponse.invalid/api/auth/sign-in/username", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Testgeraet/1.0",
        // Eigene IP pro Anfrage: rate_limit teilt sich der ganze Lauf
        "x-forwarded-for": zufallsIp(),
      },
      body: JSON.stringify({ username: benutzername, password: startpasswort }),
    }),
  );
}

test("auth.api.createUser legt die Person mit den Standardwerten der Datenbank und einer UUIDv7 an", async () => {
  const { id } = await legeAn();
  expect(id).toMatch(UUID_V7);
  expect(
    await sql`
      select muss_passwort_aendern, startpasswort_gueltig_bis, fehlversuche,
        naechster_versuch_ab, deaktiviert_am, telefon, push_programme, einwilligung_am, einwilligung_version
      from "user" where id = ${id}`,
  ).toEqual([
    {
      muss_passwort_aendern: true,
      startpasswort_gueltig_bis: expect.any(Date),
      fehlversuche: 0,
      naechster_versuch_ab: null,
      deaktiviert_am: null,
      telefon: null,
      push_programme: true,
      einwilligung_am: null,
      einwilligung_version: null,
    },
  ]);
});

test("Anmeldung mit User-Agent und X-Forwarded-For: 200, die Sitzung speichert beides nicht", async () => {
  const { id, benutzername, startpasswort } = await legeAn();
  expect((await anmelden(benutzername, startpasswort)).status).toBe(200);
  expect(
    await sql`select ip_address, user_agent from session where user_id = ${id}`,
  ).toEqual([{ ip_address: null, user_agent: null }]);
});

test("ist das Startpasswort laut Datenbank abgelaufen, liefert die Anmeldung 403 STARTPASSWORT_ABGELAUFEN, ohne Sitzung", async () => {
  const { id, benutzername, startpasswort } = await legeAn();
  await sql`
    update "user" set startpasswort_gueltig_bis = now() - interval '1 minute'
    where id = ${id}`;
  const antwort = await anmelden(benutzername, startpasswort);
  expect(antwort.status).toBe(403);
  expect((await antwort.json()).code).toBe("STARTPASSWORT_ABGELAUFEN");
  expect(await sql`select id from session where user_id = ${id}`).toEqual([]);
});

test("sechs parallele get-session mit einem Cookie, während die Verlängerung fällig ist: alle 200, gleiches Token, eine Sitzung", async () => {
  const { id, benutzername, startpasswort } = await legeAn();
  const cookie = (await anmelden(benutzername, startpasswort)).headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const { updateAge } = (await auth.$context).sessionConfig;
  const [{ token, expires_at: faellig }] = await sql`
    update session set expires_at = expires_at - make_interval(secs => ${updateAge + 60})
    where user_id = ${id}
    returning token, expires_at`;

  const antworten = await Promise.all(
    Array.from({ length: 6 }, () =>
      auth.handler(
        new Request("https://fireresponse.invalid/api/auth/get-session", {
          headers: { cookie },
        }),
      ),
    ),
  );
  for (const antwort of antworten) {
    expect(antwort.status).toBe(200);
    expect((await antwort.json()).session.token).toBe(token);
  }
  const sitzungen =
    await sql`select expires_at from session where user_id = ${id}`;
  expect(sitzungen).toHaveLength(1);
  expect(sitzungen[0].expires_at.getTime()).toBeGreaterThan(faellig.getTime());
});
