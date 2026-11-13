import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
import * as schema from "../src/db/schema.js";
import { LIMIT_STUNDE } from "../src/routes/admin/mitteilungen.js";
import { ladeSeiten } from "../src/seiten.js";
import { bereiteAuthTestsVor, erstelleTestAuth } from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  type PersonaKonto,
  type Welt,
} from "./hilfen/personas.js";

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
  seiten: ladeSeiten(),
});
// Derselbe Server ohne Schlüssel des Push-Dienstes
const ohnePush = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  seiten: ladeSeiten(),
});
afterAll(() => sql.end());

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
  fcmAttrappe.zuruecksetzen();
});
afterEach(() => ausgabe.mockRestore());

const GEHEIM = "Treffpunkt-Wort-Nur-Im-Push";
const body = (extra: Record<string, unknown> = {}) => ({
  gruppe: "alle",
  titel: "Übung fällt aus",
  text: `Heute ${GEHEIM}`,
  ...extra,
});

const senden = (
  server: typeof app,
  konto: PersonaKonto,
  daten: Record<string, unknown>,
  einheitId: string,
) =>
  server.request(`/api/v1/admin/einheiten/${einheitId}/mitteilungen`, {
    method: "POST",
    headers: { ...konto.headers, "content-type": "application/json" },
    body: JSON.stringify(daten),
  });

// Ein Token pro Konto, angemeldet über die Route wie in der App
async function token(konto: PersonaKonto) {
  const wert = `fcm-test-${randomUUID()}`;
  const antwort = await app.request("/api/v1/push-token", {
    method: "PUT",
    headers: { ...konto.headers, "content-type": "application/json" },
    body: JSON.stringify({ token: wert, plattform: "android" }),
  });
  expect(antwort.status).toBe(204);
  return wert;
}

const AKTION = "push_mitteilung_gesendet";
const audit = (akteurId: string) =>
  db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.akteurId, akteurId),
        eq(schema.auditLog.aktion, AKTION),
      ),
    );
const empfaengerTokens = () =>
  fcmAttrappe.nachrichten.map((n) => n.token).sort();

const PERSONEN = [
  "kommandoJfA",
  "stellvertretung1JfA",
  "stellvertretung2JfA",
  "leitendeJfA",
  "elternJfA",
  "teilnehmendeSelbstJfA",
  "elternKfA",
  "kommandoKfA",
  "kantonsadmin",
  "elternAundB",
] as const;
type Name = (typeof PERSONEN)[number];

describe("POST /admin/einheiten/:einheitId/mitteilungen", () => {
  let welt: Welt;
  let konten: Record<Name, PersonaKonto>;
  const tokens = {} as Record<Name, string>;
  const jfA = () => welt.einheit.jfA;
  const sortiert = (...p: Name[]) => p.map((n) => tokens[n]).sort();
  const sende = (von: Name, daten = body(), einheitId = jfA()) =>
    senden(app, konten[von], daten, einheitId);
  const anzahlAudit = async (von: Name) =>
    (await audit(konten[von].id!)).length;

  beforeAll(async () => {
    welt = await erstelleWelt(db, auth);
    konten = Object.fromEntries(
      await Promise.all(
        PERSONEN.map(async (p) => [p, await legePersonaAn(welt, p)] as const),
      ),
    ) as typeof konten;
    for (const p of PERSONEN) tokens[p] = await token(konten[p]);
    // Deaktiviert nach dem Anmelden des Tokens: Das Konto hat ein Token, bekommt aber nichts
    await db
      .update(schema.user)
      .set({ deaktiviertAm: new Date(), banned: true })
      .where(eq(schema.user.id, konten.elternAundB.id!));
  });

  test("an die ganze Einheit: Kommando, Leitende, Eltern und teilnehmende Personen; nie andere Einheiten, deaktivierte Konten oder das Konto des Kantonsadmins", async () => {
    const antwort = await sende("kommandoJfA");

    expect(antwort.status).toBe(200);
    expect(await antwort.json()).toEqual({ empfaenger: 6 });
    expect(empfaengerTokens()).toEqual(
      sortiert(
        "kommandoJfA",
        "stellvertretung1JfA",
        "stellvertretung2JfA",
        "leitendeJfA",
        "elternJfA",
        "teilnehmendeSelbstJfA",
      ),
    );
  });

  test("nur Leitende: Kommando, Stellvertretungen und Leitende, keine Eltern; die Stellvertretung darf senden", async () => {
    const antwort = await sende(
      "stellvertretung1JfA",
      body({ gruppe: "leitende" }),
    );

    expect(antwort.status).toBe(200);
    expect(await antwort.json()).toEqual({ empfaenger: 4 });
    expect(empfaengerTokens()).toEqual(
      sortiert(
        "kommandoJfA",
        "stellvertretung1JfA",
        "stellvertretung2JfA",
        "leitendeJfA",
      ),
    );
  });

  test("der Push trägt nur den Typ «mitteilung», keine id, im Kanal «termine»; der Kantonsadmin sendet an eine gewählte Einheit", async () => {
    const antwort = await sende("kantonsadmin", body({ gruppe: "leitende" }));

    expect(antwort.status).toBe(200);
    expect(fcmAttrappe.nachrichten).toHaveLength(4);
    for (const n of fcmAttrappe.nachrichten) {
      expect(n).toStrictEqual({
        token: n.token,
        notification: { title: "Übung fällt aus", body: `Heute ${GEHEIM}` },
        data: { typ: "mitteilung" },
        android: {
          priority: "high",
          notification: { sound: "default", channelId: "termine" },
        },
        apns: { payload: { aps: { sound: "default" } } },
      });
    }
  });

  test("das Audit-Log nennt Einheit, Gruppe und Zahl der Konten, nie den Text; auch das Anfrage-Log nicht", async () => {
    const vorher = await anzahlAudit("kantonsadmin");
    await sende("kantonsadmin", body({ gruppe: "alle" }));

    const zeilen = await audit(konten.kantonsadmin.id!);
    const neu = zeilen.find(
      (z) => (z.details as { gruppe: string }).gruppe === "alle",
    );
    expect(zeilen).toHaveLength(vorher + 1);
    expect(neu).toMatchObject({
      einheitId: jfA(),
      akteurId: konten.kantonsadmin.id,
      aktion: AKTION,
      zielTyp: "einheit",
      zielId: jfA(),
      details: { gruppe: "alle", konten: 6 },
    });
    expect(JSON.stringify(zeilen)).not.toContain(GEHEIM);
    expect(JSON.stringify(zeilen)).not.toContain("Übung fällt aus");
    expect(JSON.stringify(ausgabe.mock.calls)).not.toContain(GEHEIM);
  });

  test("Leitende und Eltern der Einheit bekommen 403, fremde Einheiten sind 404; es geht nichts hinaus und nichts ins Audit-Log", async () => {
    for (const von of ["leitendeJfA", "elternJfA"] as const) {
      expect((await sende(von)).status, von).toBe(403);
    }
    for (const von of ["kommandoKfA", "elternKfA"] as const) {
      expect((await sende(von)).status, von).toBe(404);
    }
    expect((await sende("kommandoJfA", body(), randomUUID())).status).toBe(404);
    expect(fcmAttrappe.nachrichten).toEqual([]);
    expect(await anzahlAudit("leitendeJfA")).toBe(0);
    expect(await anzahlAudit("elternJfA")).toBe(0);
  });

  test("das Kommando einer anderen Einheit sendet nur an die eigene", async () => {
    const antwort = await sende("kommandoKfA", body(), welt.einheit.kfA);

    expect(antwort.status).toBe(200);
    expect(empfaengerTokens()).toEqual(sortiert("elternKfA", "kommandoKfA"));
  });

  test.each([
    ["fehlender Titel", { titel: undefined }],
    ["leerer Titel", { titel: "   " }],
    ["Titel mit 61 Zeichen", { titel: "a".repeat(61) }],
    ["Titel mit Zeilenumbruch", { titel: "Zeile\nzwei" }],
    ["leerer Text", { text: "" }],
    ["Text mit 201 Zeichen", { text: "ä".repeat(201) }],
    ["Text mit Steuerzeichen", { text: "Hallo\u0007" }],
    ["unbekannte Gruppe", { gruppe: "einzelne" }],
    ["Einheit im Body", { einheitId: randomUUID() }],
    ["Empfänger im Body", { empfaenger: ["x"] }],
    ["Text als Zahl", { text: 5 }],
  ])(
    "400 bei %s, ohne Versand und ohne Audit-Eintrag",
    async (_name, extra) => {
      const vorher = await anzahlAudit("kommandoJfA");

      const antwort = await sende("kommandoJfA", body(extra));

      expect(antwort.status).toBe(400);
      expect(fcmAttrappe.nachrichten).toEqual([]);
      expect(await anzahlAudit("kommandoJfA")).toBe(vorher);
    },
  );

  test("genau 60 Zeichen Titel und 200 Zeichen Text gehen durch, gezählt als Unicode-Zeichen; Zeilenumbrüche im Text sind erlaubt", async () => {
    const antwort = await sende(
      "kommandoJfA",
      body({
        gruppe: "leitende",
        titel: "😀".repeat(60),
        text: `${"ä".repeat(190)}\n${"😀".repeat(9)}`,
      }),
    );

    expect(antwort.status).toBe(200);
  });

  test("ohne Schlüssel des Push-Dienstes: 503 PUSH_NICHT_EINGERICHTET und kein Audit-Eintrag", async () => {
    const vorher = await anzahlAudit("kommandoJfA");

    const antwort = await senden(ohnePush, konten.kommandoJfA, body(), jfA());

    expect(antwort.status).toBe(503);
    expect(await antwort.json()).toMatchObject({
      code: "PUSH_NICHT_EINGERICHTET",
    });
    expect(await anzahlAudit("kommandoJfA")).toBe(vorher);
  });

  test("ohne erreichbare Konten: 200 mit 0, kein Versand, kein Audit-Eintrag", async () => {
    const vorher = await anzahlAudit("kantonsadmin");

    const antwort = await sende("kantonsadmin", body(), welt.einheit.kfB);

    expect(antwort.status).toBe(200);
    expect(await antwort.json()).toEqual({ empfaenger: 0 });
    expect(fcmAttrappe.nachrichten).toEqual([]);
    expect(await anzahlAudit("kantonsadmin")).toBe(vorher);
  });

  describe("Rate-Limit je Konto", () => {
    const eintraege = (n: number, vorStunden: number, von: Name) =>
      db.insert(schema.auditLog).values(
        Array.from({ length: n }, () => ({
          einheitId: jfA(),
          akteurId: konten[von].id!,
          aktion: AKTION,
          zielTyp: "einheit",
          zielId: jfA(),
          erstelltAm: new Date(Date.now() - vorStunden * 3_600_000),
        })),
      );
    // Das Audit-Log ist für die API-Rolle nur anfügbar: Jeder Test nimmt darum ein eigenes Konto, nie dasselbe zweimal
    test("höchstens 5 je Stunde: die sechste ist 429 und sendet nichts", async () => {
      const vorher = await anzahlAudit("stellvertretung1JfA");
      await eintraege(4 - vorher, 0.1, "stellvertretung1JfA");

      expect((await sende("stellvertretung1JfA")).status).toBe(200);
      fcmAttrappe.zuruecksetzen();
      const gebremst = await sende("stellvertretung1JfA");

      expect(gebremst.status).toBe(429);
      expect(await gebremst.json()).toMatchObject({
        code: "ZU_VIELE_ANFRAGEN",
      });
      expect(fcmAttrappe.nachrichten).toEqual([]);
    });

    test("höchstens 20 je Tag, auch wenn die Stunde frei ist", async () => {
      await eintraege(20, 2, "stellvertretung2JfA");

      expect((await sende("stellvertretung2JfA")).status).toBe(429);
      expect(fcmAttrappe.nachrichten).toEqual([]);
    });

    test("Einträge älter als ein Tag und Einträge anderer Konten zählen nicht", async () => {
      await eintraege(30, 25, "kommandoKfA");
      await eintraege(10, 0, "stellvertretung2JfA");

      expect(
        (await sende("kommandoKfA", body(), welt.einheit.kfA)).status,
      ).toBe(200);
    });

    test("gleichzeitige Anfragen umgehen das Limit nicht", async () => {
      const vorher = await anzahlAudit("kantonsadmin");

      const antworten = await Promise.all(
        Array.from({ length: 8 }, () =>
          sende("kantonsadmin", body({ gruppe: "leitende" })),
        ),
      );

      const frei = LIMIT_STUNDE - vorher;
      expect(antworten.map((a) => a.status).sort()).toEqual([
        ...Array<number>(frei).fill(200),
        ...Array<number>(8 - frei).fill(429),
      ]);
      expect(await anzahlAudit("kantonsadmin")).toBe(LIMIT_STUNDE);
    });
  });
});
