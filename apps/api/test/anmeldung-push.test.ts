import { randomUUID } from "node:crypto";
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
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { ladeSeiten } from "../src/seiten.js";
import {
  bereiteAuthTestsVor,
  erstelleTestAuth,
  fcmNachricht,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  type Persona,
  type PersonaKonto,
  type Welt,
} from "./hilfen/personas.js";
import { legeProgrammAn } from "./hilfen/programme.js";

const fcmAttrappe = bereiteAuthTestsVor();

const sql = postgres(API_URL);
const db = erstelleDb(sql);
const auth = erstelleTestAuth(db);
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  fcm: fcmAttrappe,
  // Die Termine liegen fest im Oktober 2027, das Fenster ist darum weit offen
  anmeldefensterTage: 365,
  seiten: ladeSeiten(),
});
afterAll(() => sql.end());

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

// Eine Welt pro Test: Die Tests zählen Pushes, die Konten dürfen sich nicht teilen
let welt: Welt;
beforeEach(async () => {
  welt = await erstelleWelt(db, auth);
  fcmAttrappe.zuruecksetzen();
});

const person = (persona: Persona) => legePersonaAn(welt, persona);

const aufruf = (
  konto: PersonaKonto,
  methode: "PUT" | "PATCH",
  pfad: string,
  body: unknown,
) =>
  app.request(pfad, {
    method: methode,
    headers: { ...konto.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const melde = (
  konto: PersonaKonto,
  programmId: string,
  status: "ja" | "nein" = "ja",
  teilnehmendeId = welt.teilnehmende.jfA,
) =>
  aufruf(
    konto,
    "PUT",
    `/api/v1/programme/${programmId}/teilnahmen/${teilnehmendeId}`,
    {
      status,
    },
  );

// Ein Token pro Konto, angemeldet über die Route wie in der App
async function token(konto: PersonaKonto) {
  const wert = `fcm-test-${randomUUID()}`;
  const antwort = await aufruf(konto, "PUT", "/api/v1/push-token", {
    token: wert,
    plattform: "android",
  });
  expect(antwort.status).toBe(204);
  return wert;
}

// 2027-10-30 ist ein Samstag
const waldtag = () =>
  legeProgrammAn(db, {
    einheitId: welt.einheit.jfA,
    titel: "Waldtag",
    tagVon: "2027-10-30",
  });

const empfaenger = () => fcmAttrappe.nachrichten.map((n) => n.token).sort();

describe("Anmelde-Push bei PUT /programme/:id/teilnahmen/:teilnehmendeId", () => {
  test("geht an Kommando, Stellvertretung und Leitende der Einheit, ohne Namen und nie an andere Einheiten, Eltern oder das Kantonsadmin-Konto", async () => {
    const [eltern, leitung, sl, stv, slB, admin] = await Promise.all([
      person("elternJfA"),
      person("leitendeJfA"),
      person("kommandoJfA"),
      person("stellvertretung1JfA"),
      person("kommandoKfA"),
      person("kantonsadmin"),
    ]);
    const [tLeitung, tSl, tStv] = await Promise.all(
      [leitung, sl, stv].map(token),
    );
    await Promise.all([eltern, slB, admin].map(token));
    const p = await waldtag();

    expect((await melde(eltern, p.id)).status).toBe(204);

    expect(empfaenger()).toEqual([tLeitung, tSl, tStv].sort());
    expect(fcmAttrappe.nachrichten).toStrictEqual(
      expect.arrayContaining([
        fcmNachricht(
          tSl,
          "Neue Anmeldung",
          { typ: "programm", id: p.id },
          "anmeldungen",
          "In Fire-Response",
        ),
      ]),
    );
    expect(JSON.stringify(fcmAttrappe.nachrichten)).not.toMatch(
      /Kind|Waldtag|Sa 30/,
    );
  });

  test("Abmeldung und Wechsel von «nein» auf «ja» haben je ihren Text", async () => {
    const [eltern, sl] = await Promise.all([
      person("elternJfA"),
      person("kommandoJfA"),
    ]);
    await token(sl);
    const p = await waldtag();

    await melde(eltern, p.id, "nein");
    await melde(eltern, p.id, "ja");

    expect(fcmAttrappe.nachrichten.map((n) => n.notification)).toEqual([
      { title: "Neue Abmeldung", body: "In Fire-Response" },
      { title: "Neue Anmeldung", body: "In Fire-Response" },
    ]);
  });

  test("gleicher Wert löst keinen Push aus und lässt die Antwort bestehen", async () => {
    const [eltern, sl] = await Promise.all([
      person("elternJfA"),
      person("kommandoJfA"),
    ]);
    await token(sl);
    const p = await waldtag();
    await melde(eltern, p.id);
    fcmAttrappe.zuruecksetzen();

    expect((await melde(eltern, p.id)).status).toBe(204);

    expect(fcmAttrappe.nachrichten).toEqual([]);
    const zeilen = await db
      .select({ status: schema.teilnahme.status })
      .from(schema.teilnahme)
      .where(eq(schema.teilnahme.programmId, p.id));
    expect(zeilen).toEqual([{ status: "ja" }]);
  });

  test("die handelnde Person bekommt nichts, das übrige Kommando schon", async () => {
    const [leitung, sl] = await Promise.all([
      person("leitendeJfA"),
      person("kommandoJfA"),
    ]);
    // Die Leitende ist zugleich Elternteil einer teilnehmenden Person derselben Einheit
    await db.insert(schema.teilnehmendeKonto).values({
      userId: leitung.id!,
      teilnehmendeId: welt.teilnehmende.jfA2,
      art: "eltern",
    });
    const [, tSl] = await Promise.all([leitung, sl].map(token));
    const p = await waldtag();

    expect(
      (await melde(leitung, p.id, "ja", welt.teilnehmende.jfA2)).status,
    ).toBe(204);

    expect(empfaenger()).toEqual([tSl]);
  });

  test("Schalter aus: kein Push; wieder an: Push", async () => {
    const [eltern, sl, leitung] = await Promise.all([
      person("elternJfA"),
      person("kommandoJfA"),
      person("leitendeJfA"),
    ]);
    const [tSl, tLeitung] = await Promise.all([sl, leitung].map(token));
    const p = await waldtag();
    expect(
      (await aufruf(sl, "PATCH", "/api/v1/ich", { pushAnmeldungen: false }))
        .status,
    ).toBe(204);

    await melde(eltern, p.id);
    expect(empfaenger()).toEqual([tLeitung]);

    expect(
      (await aufruf(sl, "PATCH", "/api/v1/ich", { pushAnmeldungen: true }))
        .status,
    ).toBe(204);
    fcmAttrappe.zuruecksetzen();
    await melde(eltern, p.id, "nein");
    expect(empfaenger()).toEqual([tSl, tLeitung].sort());
  });

  test("deaktivierte Konten bekommen nichts", async () => {
    const [eltern, sl] = await Promise.all([
      person("elternJfA"),
      person("kommandoJfA"),
    ]);
    await token(sl);
    await db
      .update(schema.user)
      .set({ deaktiviertAm: new Date() })
      .where(eq(schema.user.id, sl.id!));
    const p = await waldtag();

    expect((await melde(eltern, p.id)).status).toBe(204);

    expect(fcmAttrappe.nachrichten).toEqual([]);
  });

  test("die eigene Anmeldung der Leitenden löst nichts aus", async () => {
    const [leitung, sl] = await Promise.all([
      person("leitendeJfA"),
      person("kommandoJfA"),
    ]);
    await token(sl);
    const p = await waldtag();

    const antwort = await aufruf(
      leitung,
      "PUT",
      `/api/v1/programme/${p.id}/leitung`,
      { status: "ja" },
    );

    expect(antwort.status).toBe(204);
    expect(fcmAttrappe.nachrichten).toEqual([]);
  });

  test("ein Ausfall von FCM lässt den Aufruf nicht scheitern, die Antwort bleibt gespeichert", async () => {
    const [eltern, sl] = await Promise.all([
      person("elternJfA"),
      person("kommandoJfA"),
    ]);
    await token(sl);
    const p = await waldtag();
    fcmAttrappe.ausfall = true;

    expect((await melde(eltern, p.id)).status).toBe(204);

    const zeilen = await db
      .select({ status: schema.teilnahme.status })
      .from(schema.teilnahme)
      .where(eq(schema.teilnahme.programmId, p.id));
    expect(zeilen).toEqual([{ status: "ja" }]);
  });

  test("abgelehnte Aufrufe (404, 409) lösen nichts aus", async () => {
    const [eltern, sl] = await Promise.all([
      person("elternJfA"),
      person("kommandoJfA"),
    ]);
    await token(sl);
    const p = await waldtag();
    const begonnen = await legeProgrammAn(db, {
      einheitId: welt.einheit.jfA,
      beginn: new Date("2020-01-01T10:00:00Z"),
    });

    expect(
      (await melde(eltern, p.id, "ja", welt.teilnehmende.jfA2)).status,
    ).toBe(404);
    expect((await melde(eltern, begonnen.id)).status).toBe(409);

    expect(fcmAttrappe.nachrichten).toEqual([]);
  });
});
