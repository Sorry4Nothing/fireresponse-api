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
import { ladeSeiten } from "../src/seiten.js";
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
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  seiten: ladeSeiten(),
});
afterAll(() => sql.end());

let welt: Welt;
let admin: PersonaKonto;
let kommando: PersonaKonto;
let fremdesKommando: PersonaKonto;
let leitende: PersonaKonto;
let eltern: PersonaKonto;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  [admin, kommando, fremdesKommando, leitende, eltern] = await Promise.all([
    legePersonaAn(welt, "kantonsadmin"),
    legePersonaAn(welt, "kommandoJfA"),
    legePersonaAn(welt, "kommandoKfA"),
    legePersonaAn(welt, "leitendeJfA"),
    legePersonaAn(welt, "elternJfA"),
  ]);
});

// Jede Anfrage schreibt sonst eine Log-Zeile in die Testausgabe
let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

function anfrage(
  konto: PersonaKonto,
  methode: string,
  pfad: string,
  body?: Record<string, unknown>,
) {
  return app.request(pfad, {
    method: methode,
    headers: body
      ? { ...konto.headers, "content-type": "application/json" }
      : konto.headers,
    body: body && JSON.stringify(body),
  });
}

// Die Einheit steht im Pfad: Sie kommt vom Umschalter der Verwaltung, nie aus dem Body
const basis = (einheitId = welt.einheit.jfA) =>
  `/api/v1/admin/einheiten/${einheitId}/zeitregeln`;
const regelBody = (extra: Record<string, unknown> = {}) => ({
  tageVorher: 3,
  uhrzeit: "08:00",
  text: "{Programm} am {Datum}: bitte antworten",
  aktiv: true,
  ...extra,
});

async function legeRegelAn(
  konto = kommando,
  extra: Record<string, unknown> = {},
  einheitId = welt.einheit.jfA,
) {
  const antwort = await anfrage(
    konto,
    "POST",
    basis(einheitId),
    regelBody(extra),
  );
  expect(antwort.status).toBe(201);
  return ((await antwort.json()) as { id: string }).id;
}

const zeile = async (id: string) =>
  (
    await db.select().from(schema.zeitregel).where(eq(schema.zeitregel.id, id))
  )[0];

const auditZeilen = (zielId: string) =>
  db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.zielId, zielId))
    .orderBy(schema.auditLog.erstelltAm);

describe("POST /api/v1/admin/einheiten/:einheitId/zeitregeln", () => {
  test("legt die Regel in der Einheit an, getrimmt, und schreibt das Audit-Log ohne Text", async () => {
    const id = await legeRegelAn(kommando, {
      tageVorher: 7,
      uhrzeit: "23:59",
      text: "  Erinnerung  ",
      aktiv: false,
    });
    expect(await zeile(id)).toMatchObject({
      einheitId: welt.einheit.jfA,
      tageVorher: 7,
      uhrzeit: "23:59",
      text: "Erinnerung",
      aktiv: false,
    });
    const [audit] = await auditZeilen(id);
    expect(audit).toMatchObject({
      einheitId: welt.einheit.jfA,
      akteurId: kommando.id,
      aktion: "zeitregel_angelegt",
      zielTyp: "zeitregel",
      details: { tageVorher: 7, uhrzeit: "23:59", aktiv: false },
    });
    expect(JSON.stringify(audit)).not.toContain("Erinnerung");
  });

  test("das Kantonsadmin-Konto verwaltet die Regeln jeder Einheit", async () => {
    const id = await legeRegelAn(admin, {}, welt.einheit.kfB);
    expect((await zeile(id))!.einheitId).toBe(welt.einheit.kfB);
  });

  test("die Beschreibung ist optional, wird getrimmt und läuft nicht ins Audit-Log", async () => {
    const ohne = await legeRegelAn();
    expect((await zeile(ohne))?.beschreibung).toBeNull();
    const mit = await legeRegelAn(kommando, {
      beschreibung: "  Bitte bis Freitag antworten  ",
    });
    expect((await zeile(mit))?.beschreibung).toBe(
      "Bitte bis Freitag antworten",
    );
    expect(JSON.stringify(await auditZeilen(mit))).not.toContain("Freitag");
    for (const beschreibung of ["   ", "x".repeat(301)]) {
      expect(
        (await anfrage(kommando, "POST", basis(), regelBody({ beschreibung })))
          .status,
      ).toBe(400);
    }
  });

  test("Leitende und Eltern bekommen 403, fremde und unbekannte Einheiten 404", async () => {
    for (const konto of [leitende, eltern]) {
      expect((await anfrage(konto, "POST", basis(), regelBody())).status).toBe(
        403,
      );
    }
    expect(
      (await anfrage(fremdesKommando, "POST", basis(), regelBody())).status,
    ).toBe(404);
    expect(
      (await anfrage(kommando, "POST", basis(randomUUID()), regelBody()))
        .status,
    ).toBe(404);
    expect(
      (await anfrage(kommando, "POST", basis(welt.einheit.kfA), regelBody()))
        .status,
    ).toBe(404);
  });

  test.each([
    ["Abstand -1", { tageVorher: -1 }],
    ["Abstand 8", { tageVorher: 8 }],
    ["Abstand als Text", { tageVorher: "3" }],
    ["Uhrzeit 24:00", { uhrzeit: "24:00" }],
    ["Uhrzeit 8:00", { uhrzeit: "8:00" }],
    ["Uhrzeit 08:60", { uhrzeit: "08:60" }],
    ["leerer Text", { text: "   " }],
    ["Text mit 151 Zeichen", { text: "a".repeat(151) }],
    ["fehlendes aktiv", { aktiv: undefined }],
    ["einheitId im Body", { einheitId: "x" }],
  ])("%s gibt 400", async (_titel, extra) => {
    const antwort = await anfrage(kommando, "POST", basis(), regelBody(extra));
    expect(antwort.status).toBe(400);
  });
});

describe("GET /api/v1/admin/einheiten/:einheitId/zeitregeln", () => {
  test("listet nur die Regeln der eigenen Einheit, nach Abstand (grösster zuerst) und Uhrzeit", async () => {
    const spaet = await legeRegelAn(kommando, {
      tageVorher: 2,
      uhrzeit: "18:00",
    });
    const frueh = await legeRegelAn(kommando, {
      tageVorher: 2,
      uhrzeit: "07:00",
    });
    const fremd = await legeRegelAn(
      fremdesKommando,
      { tageVorher: 1 },
      welt.einheit.kfA,
    );
    const antwort = await anfrage(kommando, "GET", basis());
    expect(antwort.status).toBe(200);
    const { regeln } = (await antwort.json()) as { regeln: { id: string }[] };
    const ids = regeln.map((r) => r.id);
    expect(ids).not.toContain(fremd);
    expect(ids.indexOf(frueh)).toBeLessThan(ids.indexOf(spaet));
    expect(regeln.find((r) => r.id === frueh)).toEqual({
      id: frueh,
      tageVorher: 2,
      uhrzeit: "07:00",
      text: "{Programm} am {Datum}: bitte antworten",
      beschreibung: null,
      aktiv: true,
    });
  });

  test("Leitende bekommen 403, fremde Einheiten 404", async () => {
    expect((await anfrage(leitende, "GET", basis())).status).toBe(403);
    expect((await anfrage(fremdesKommando, "GET", basis())).status).toBe(404);
  });
});

describe("PATCH /api/v1/admin/einheiten/:einheitId/zeitregeln/:id", () => {
  test("ändert nur die genannten Felder und schreibt das Audit-Log ohne Text", async () => {
    const id = await legeRegelAn();
    const antwort = await anfrage(kommando, "PATCH", `${basis()}/${id}`, {
      uhrzeit: "09:15",
      text: "Neuer Text",
    });
    expect(antwort.status).toBe(204);
    expect(await zeile(id)).toMatchObject({
      tageVorher: 3,
      uhrzeit: "09:15",
      text: "Neuer Text",
      aktiv: true,
    });
    const [, audit] = await auditZeilen(id);
    expect(audit).toMatchObject({
      aktion: "zeitregel_geaendert",
      details: { uhrzeit: "09:15", textGeaendert: true },
    });
    expect(JSON.stringify(audit)).not.toContain("Neuer Text");
  });

  test("die Beschreibung lässt sich setzen und mit null entfernen, ohne im Audit-Log zu stehen", async () => {
    const id = await legeRegelAn();
    expect(
      (
        await anfrage(kommando, "PATCH", `${basis()}/${id}`, {
          beschreibung: "Geheime Beschreibung",
        })
      ).status,
    ).toBe(204);
    expect((await zeile(id))?.beschreibung).toBe("Geheime Beschreibung");
    expect(
      (
        await anfrage(kommando, "PATCH", `${basis()}/${id}`, {
          beschreibung: null,
        })
      ).status,
    ).toBe(204);
    expect((await zeile(id))?.beschreibung).toBeNull();
    expect(JSON.stringify(await auditZeilen(id))).not.toContain("Geheime");
  });

  test("ein leerer Body ändert nichts und schreibt kein Audit-Log", async () => {
    const id = await legeRegelAn();
    expect(
      (await anfrage(kommando, "PATCH", `${basis()}/${id}`, {})).status,
    ).toBe(204);
    expect(await auditZeilen(id)).toHaveLength(1);
  });

  test("eine Regel einer anderen Einheit ist 404 und bleibt unverändert, auch mit dem Pfad der eigenen", async () => {
    const id = await legeRegelAn(fremdesKommando, {}, welt.einheit.kfA);
    // Pfad der eigenen Einheit, Regel der fremden
    expect(
      (await anfrage(kommando, "PATCH", `${basis()}/${id}`, { aktiv: false }))
        .status,
    ).toBe(404);
    // Pfad der fremden Einheit
    expect(
      (
        await anfrage(kommando, "PATCH", `${basis(welt.einheit.kfA)}/${id}`, {
          aktiv: false,
        })
      ).status,
    ).toBe(404);
    expect((await zeile(id))!.aktiv).toBe(true);
  });

  test("Leitende und Eltern bekommen 403", async () => {
    const id = await legeRegelAn();
    for (const konto of [leitende, eltern]) {
      expect(
        (await anfrage(konto, "PATCH", `${basis()}/${id}`, { aktiv: false }))
          .status,
      ).toBe(403);
    }
    expect((await zeile(id))!.aktiv).toBe(true);
  });
});

describe("DELETE /api/v1/admin/einheiten/:einheitId/zeitregeln/:id", () => {
  test("löscht die Regel samt gesendet-Zeilen und schreibt das Audit-Log", async () => {
    const id = await legeRegelAn();
    const [programm] = await db
      .insert(schema.programm)
      .values({
        einheitId: welt.einheit.jfA,
        googleEventId: `regel-loeschen-${id}`,
        titel: "Programm",
        ganztaegig: true,
        tagVon: "2027-03-06",
        tagBis: "2027-03-06",
      })
      .returning({ id: schema.programm.id });
    await db
      .insert(schema.zeitregelGesendet)
      .values({ regelId: id, programmId: programm!.id });

    expect((await anfrage(kommando, "DELETE", `${basis()}/${id}`)).status).toBe(
      204,
    );
    expect(await zeile(id)).toBeUndefined();
    expect(
      await db
        .select()
        .from(schema.zeitregelGesendet)
        .where(eq(schema.zeitregelGesendet.regelId, id)),
    ).toEqual([]);
    expect((await auditZeilen(id)).map((a) => a.aktion)).toEqual([
      "zeitregel_angelegt",
      "zeitregel_geloescht",
    ]);
    expect((await anfrage(kommando, "DELETE", `${basis()}/${id}`)).status).toBe(
      404,
    );
  });

  test("eine Regel einer anderen Einheit ist 404, Leitende und Eltern bekommen 403", async () => {
    const fremd = await legeRegelAn(fremdesKommando, {}, welt.einheit.kfA);
    expect(
      (await anfrage(kommando, "DELETE", `${basis()}/${fremd}`)).status,
    ).toBe(404);
    const eigene = await legeRegelAn();
    for (const konto of [leitende, eltern]) {
      expect(
        (await anfrage(konto, "DELETE", `${basis()}/${eigene}`)).status,
      ).toBe(403);
    }
    expect(await zeile(fremd)).toBeDefined();
    expect(await zeile(eigene)).toBeDefined();
  });
});
