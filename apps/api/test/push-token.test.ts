import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import { ladeSeiten } from "../src/seiten.js";
import {
  APP,
  bereiteAuthTestsVor,
  cookiesAus,
  erstelleTestAuth,
  zufallsIp,
} from "./hilfen/auth.js";
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
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  seiten: ladeSeiten(),
});

let welt: Welt;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
});
afterAll(() => sql.end());

// Form eines FCM-Registrierungstokens: Instanz-ID, Doppelpunkt, langer Rest
const token = () => `${randomUUID().replace(/-/g, "")}:APA91b${randomUUID()}`;

function melden(konto: PersonaKonto, body: unknown) {
  return app.request("/api/v1/push-token", {
    method: "PUT",
    headers: { ...konto.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const zeilen = (userId: string | null) =>
  sql`select session_id, token, plattform from push_token where user_id = ${userId} order by token`;

async function sitzungId(headers: Record<string, string>) {
  const sitzung = await auth.api.getSession({ headers });
  return sitzung!.session.id;
}

// Wie ein zweites Gerät derselben Person (Muster aus test/sitzungen-beenden.test.ts)
async function zweiteSitzung(konto: PersonaKonto) {
  const anmeldung = await auth.api.signInUsername({
    body: { username: konto.benutzername!, password: konto.passwort! },
    returnHeaders: true,
  });
  return {
    "expo-origin": APP,
    "x-forwarded-for": zufallsIp(),
    cookie: cookiesAus(anmeldung),
  };
}

test("204, und die Zeile hängt an Sitzung und Person des Aufrufers", async () => {
  const konto = await legePersonaAn(welt, "elternA");
  const eigenes = token();

  const antwort = await melden(konto, { token: eigenes, plattform: "android" });

  expect(antwort.status).toBe(204);
  expect(await antwort.text()).toBe("");
  expect(await zeilen(konto.id)).toEqual([
    {
      session_id: await sitzungId(konto.headers),
      token: eigenes,
      plattform: "android",
    },
  ]);
});

test("ein neues Token derselben Sitzung ersetzt das alte", async () => {
  const konto = await legePersonaAn(welt, "elternA");
  const neues = token();

  expect(
    (await melden(konto, { token: token(), plattform: "ios" })).status,
  ).toBe(204);
  expect((await melden(konto, { token: neues, plattform: "ios" })).status).toBe(
    204,
  );

  expect(await zeilen(konto.id)).toEqual([
    {
      session_id: await sitzungId(konto.headers),
      token: neues,
      plattform: "ios",
    },
  ]);
});

test("dasselbe Token aus der Sitzung einer anderen Person zieht um (geteiltes Handy)", async () => {
  const vorher = await legePersonaAn(welt, "slA");
  const nachher = await legePersonaAn(welt, "elternA");
  const geraet = token();

  expect(
    (await melden(vorher, { token: geraet, plattform: "ios" })).status,
  ).toBe(204);
  expect(
    (await melden(nachher, { token: geraet, plattform: "ios" })).status,
  ).toBe(204);

  expect(await zeilen(vorher.id)).toEqual([]);
  expect(
    await sql`select user_id from push_token where token = ${geraet}`,
  ).toEqual([{ user_id: nachher.id }]);
});

test("ein FCM-Token wird gespeichert, die Expo-Form und Unbrauchbares geben 400", async () => {
  const konto = await legePersonaAn(welt, "elternA");
  const gueltig = token();
  expect(
    (await melden(konto, { token: gueltig, plattform: "android" })).status,
  ).toBe(204);
  expect((await zeilen(konto.id)).map((z) => z.token)).toEqual([gueltig]);

  for (const schlecht of [
    `ExponentPushToken[${randomUUID()}]`,
    `ExpoPushToken[${randomUUID()}]`,
    "",
    "zu-kurz",
    `${gueltig} mit Leerzeichen`,
    `${gueltig}\n`,
    "x".repeat(513),
  ]) {
    expect(
      (await melden(konto, { token: schlecht, plattform: "ios" })).status,
      schlecht.slice(0, 30),
    ).toBe(400);
  }
  expect((await zeilen(konto.id)).map((z) => z.token)).toEqual([gueltig]);
});

test("überzählige Felder, falsche Token-Form, fremde Plattform und leerer Body geben 400", async () => {
  const konto = await legePersonaAn(welt, "elternA");
  const gueltig = { token: token(), plattform: "ios" };

  for (const body of [
    { ...gueltig, userId: konto.id },
    { ...gueltig, sessionId: randomUUID() },
    { ...gueltig, token: "kein token" },
    { ...gueltig, plattform: "web" },
  ]) {
    expect((await melden(konto, body)).status, JSON.stringify(body)).toBe(400);
  }
  const leer = await app.request("/api/v1/push-token", {
    method: "PUT",
    headers: { ...konto.headers, "content-type": "application/json" },
    body: "",
  });
  expect(leer.status).toBe(400);
  expect(await zeilen(konto.id)).toEqual([]);
});

test("keine Log-Zeile enthält das Token", async () => {
  const konto = await legePersonaAn(welt, "elternA");
  const geheim = token();
  const ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await melden(konto, { token: geheim, plattform: "ios" });
    expect(ausgabe.mock.calls.flat().join("\n")).not.toContain(geheim);
    expect(ausgabe).toHaveBeenCalled();
  } finally {
    ausgabe.mockRestore();
  }
});

test("nach dem Abmelden ist das Token weg, das einer anderen Person bleibt", async () => {
  const geht = await legePersonaAn(welt, "elternA");
  const bleibt = await legePersonaAn(welt, "elternB");
  expect(
    (await melden(geht, { token: token(), plattform: "ios" })).status,
  ).toBe(204);
  expect(
    (await melden(bleibt, { token: token(), plattform: "ios" })).status,
  ).toBe(204);

  // Über die App wie der Client; ohne expo-origin in den Kopfzeilen antwortete better-auth 403
  const abmelden = await app.request("/api/auth/sign-out", {
    method: "POST",
    headers: geht.headers,
  });
  expect(abmelden.status).toBe(200);

  expect(await zeilen(geht.id)).toEqual([]);
  expect(await zeilen(bleibt.id)).toHaveLength(1);
});

test("«überall abmelden» nimmt die Tokens beider Sitzungen mit", async () => {
  const konto = await legePersonaAn(welt, "elternA");
  const zweite = { ...konto, headers: await zweiteSitzung(konto) };
  expect(
    (await melden(konto, { token: token(), plattform: "ios" })).status,
  ).toBe(204);
  expect(
    (await melden(zweite, { token: token(), plattform: "android" })).status,
  ).toBe(204);
  expect(await zeilen(konto.id)).toHaveLength(2);

  const antwort = await app.request("/api/auth/revoke-sessions", {
    method: "POST",
    headers: konto.headers,
  });
  expect(antwort.status).toBe(200);

  expect(await zeilen(konto.id)).toEqual([]);
});

test("beide Fremdschlüssel löschen per CASCADE", async () => {
  const regeln = await sql`
    select conname, confdeltype from pg_constraint
    where contype = 'f' and conrelid = 'push_token'::regclass
    order by conname`;
  expect(regeln).toEqual([
    { conname: "push_token_session_id_session_id_fk", confdeltype: "c" },
    { conname: "push_token_user_id_user_id_fk", confdeltype: "c" },
  ]);
});
