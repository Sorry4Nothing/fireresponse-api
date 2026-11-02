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
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { ZWECK_LODUR_LINK } from "../src/lodur-url.js";
import { ladeSeiten } from "../src/seiten.js";
import { entschluessele } from "../src/startpasswort.js";
import { bereiteAuthTestsVor, erstelleTestAuth } from "./hilfen/auth.js";
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
const HOST = "kalender.example.org";
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  seiten: ladeSeiten(),
  lodurErlaubteHosts: [HOST],
});
afterAll(() => sql.end());

let welt: Welt;
let kommando: PersonaKonto;
let admin: PersonaKonto;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  [kommando, admin] = await Promise.all([
    legePersonaAn(welt, "kommandoJfA"),
    legePersonaAn(welt, "kantonsadmin"),
  ]);
});

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

const GEHEIMNIS = `geheim-${randomUUID()}`;
const LINK = `https://${HOST}/ical/${GEHEIMNIS}?key=abc`;
const pfad = (einheitId = welt.einheit.jfA) =>
  `/api/v1/admin/einheiten/${einheitId}/lodur`;
const anfrage = (
  konto: PersonaKonto,
  methode: string,
  body?: unknown,
  einheitId?: string,
) =>
  app.request(pfad(einheitId), {
    method: methode,
    headers: body
      ? { ...konto.headers, "content-type": "application/json" }
      : konto.headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const einheitZeile = async (id = welt.einheit.jfA) =>
  (await db.select().from(schema.einheit).where(eq(schema.einheit.id, id)))[0]!;

describe("PUT /api/v1/admin/einheiten/:einheitId/lodur", () => {
  test("speichert den ganzen Link verschlüsselt und antwortet nur mit dem Host", async () => {
    const res = await anfrage(kommando, "PUT", { url: LINK });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      gesetzt: true,
      maskiert: `https://${HOST}/…`,
      syncOkAm: null,
      syncFehler: null,
    });
    expect(text).not.toContain(GEHEIMNIS);

    const e = await einheitZeile();
    // In der Datenbank steht weder der Host noch das Geheimnis, und der Text lässt sich zurücklesen
    expect(e.lodurUrlVerschluesselt).not.toContain(HOST);
    expect(e.lodurUrlVerschluesselt).not.toContain(GEHEIMNIS);
    expect(entschluessele(e.lodurUrlVerschluesselt, ZWECK_LODUR_LINK)).toBe(
      LINK,
    );
    expect(e.lodurUrlGesetztAm).toBeInstanceOf(Date);
    // Nie im Log
    expect(JSON.stringify(ausgabe.mock.calls)).not.toContain(GEHEIMNIS);
  });

  test("GET zeigt den Stand, den Link nie", async () => {
    await anfrage(kommando, "PUT", { url: LINK });
    await db
      .update(schema.einheit)
      .set({ syncOkAm: new Date("2026-11-02T12:00:00Z"), syncFehler: "leer" })
      .where(eq(schema.einheit.id, welt.einheit.jfA));
    const res = await anfrage(admin, "GET");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      gesetzt: true,
      maskiert: `https://${HOST}/…`,
      syncOkAm: "2026-11-02T12:00:00.000Z",
      syncFehler: "leer",
    });
    expect(text).not.toContain(GEHEIMNIS);
  });

  test("ein neuer Link beginnt ohne Stand; das Audit-Log nennt die Aktion, nicht den Link", async () => {
    await db
      .update(schema.einheit)
      .set({ syncOkAm: new Date(), syncFehler: "http-fehler" })
      .where(eq(schema.einheit.id, welt.einheit.jfA));
    await anfrage(kommando, "PUT", { url: LINK });
    expect(await einheitZeile()).toMatchObject({
      syncOkAm: null,
      syncFehler: null,
    });
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.zielId, welt.einheit.jfA));
    const gesetzt = audit.filter((a) => a.aktion === "lodur_link_gesetzt");
    expect(gesetzt.at(-1)).toMatchObject({
      einheitId: welt.einheit.jfA,
      akteurId: kommando.id,
      zielTyp: "einheit",
      details: null,
    });
    expect(JSON.stringify(audit)).not.toContain(GEHEIMNIS);
  });

  test.each([
    ["http", `http://${HOST}/ical/x`],
    ["anderer Host", "https://boese.example.net/ical/x"],
    ["Port", `https://${HOST}:8443/ical/x`],
    ["Zugangsdaten", `https://nutzer:pw@${HOST}/ical/x`],
    ["IP-Adresse", "https://127.0.0.1/ical/x"],
    ["kein Link", "kalender"],
  ])("lehnt ab und ändert nichts: %s", async (_, url) => {
    await anfrage(kommando, "PUT", { url: LINK });
    const vorher = await einheitZeile();
    const res = await anfrage(kommando, "PUT", { url });
    expect(res.status).toBe(400);
    const koerper = await res.json();
    expect(koerper).toMatchObject({ code: "LODUR_LINK_UNGUELTIG" });
    // Die Antwort wiederholt den Link nicht
    expect(JSON.stringify(koerper)).not.toContain(url);
    expect(await einheitZeile()).toEqual(vorher);
  });

  test.each([{}, { url: "" }, { url: 5 }, { url: LINK, extra: 1 }])(
    "lehnt den Body %j mit 400 ab",
    async (body) => {
      const res = await anfrage(kommando, "PUT", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "UNGUELTIGE_EINGABE" });
    },
  );

  test("ohne erlaubte Hosts in der Konfiguration nimmt die API keinen Link an", async () => {
    const ohne = erstelleApp({
      appMinVersion: "1.2.0",
      sql,
      db,
      auth,
      seiten: ladeSeiten(),
    });
    const res = await ohne.request(pfad(), {
      method: "PUT",
      headers: { ...kommando.headers, "content-type": "application/json" },
      body: JSON.stringify({ url: LINK }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/v1/admin/einheiten/:einheitId/lodur", () => {
  test("entfernt den Link und den Stand, die Termine bleiben", async () => {
    await anfrage(kommando, "PUT", { url: LINK });
    const [termin] = await db
      .insert(schema.programm)
      .values({
        einheitId: welt.einheit.jfA,
        googleEventId: `lodur-${randomUUID()}`,
        titel: "Bleibt",
        ganztaegig: true,
        tagVon: "2027-03-06",
        tagBis: "2027-03-06",
      })
      .returning();
    const res = await anfrage(kommando, "DELETE");
    expect(res.status).toBe(204);
    expect(await einheitZeile()).toMatchObject({
      lodurUrlVerschluesselt: null,
      lodurUrlGesetztAm: null,
      syncOkAm: null,
      syncFehler: null,
    });
    expect(await (await anfrage(kommando, "GET")).json()).toEqual({
      gesetzt: false,
      maskiert: null,
      syncOkAm: null,
      syncFehler: null,
    });
    expect(
      await db
        .select()
        .from(schema.programm)
        .where(eq(schema.programm.id, termin!.id)),
    ).toHaveLength(1);
  });
});

describe("Mandantentrennung", () => {
  test("das Kommando einer anderen Einheit sieht den Link nicht und ändert ihn nicht (404)", async () => {
    await anfrage(kommando, "PUT", { url: LINK });
    const fremd = await legePersonaAn(welt, "kommandoKfA");
    for (const methode of ["GET", "PUT", "DELETE"]) {
      const res = await anfrage(
        fremd,
        methode,
        methode === "PUT" ? { url: LINK } : undefined,
      );
      expect(res.status, methode).toBe(404);
    }
    expect((await einheitZeile()).lodurUrlVerschluesselt).not.toBeNull();
  });
});
