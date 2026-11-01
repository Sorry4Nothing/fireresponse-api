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
let demoAdmin: PersonaKonto;
let eltern: PersonaKonto;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  admin = await legePersonaAn(welt, "admin");
  demoAdmin = await legePersonaAn(welt, "demoAdmin");
  eltern = await legePersonaAn(welt, "elternA");
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

const BASIS = "/api/v1/admin/zeitregeln";
const regelBody = (extra: Record<string, unknown> = {}) => ({
  stufeId: null,
  wochentag: 3,
  uhrzeit: "08:00",
  text: "{Programm} am {Datum}: bitte antworten",
  aktiv: true,
  ...extra,
});

async function legeRegelAn(konto = admin, extra: Record<string, unknown> = {}) {
  const antwort = await anfrage(konto, "POST", BASIS, regelBody(extra));
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

describe("POST /api/v1/admin/zeitregeln", () => {
  test("legt die Regel in der Abteilung des Admins an, getrimmt, und schreibt das Audit-Log ohne Text", async () => {
    const id = await legeRegelAn(admin, {
      stufeId: welt.stufeAId,
      wochentag: 7,
      uhrzeit: "23:59",
      text: "  Erinnerung  ",
      aktiv: false,
    });
    expect(await zeile(id)).toMatchObject({
      abteilungId: welt.testabteilungId,
      stufeId: welt.stufeAId,
      wochentag: 7,
      uhrzeit: "23:59",
      text: "Erinnerung",
      aktiv: false,
    });
    const [audit] = await auditZeilen(id);
    expect(audit).toMatchObject({
      abteilungId: welt.testabteilungId,
      akteurId: admin.id,
      aktion: "zeitregel_angelegt",
      zielTyp: "zeitregel",
      details: {
        stufeId: welt.stufeAId,
        wochentag: 7,
        uhrzeit: "23:59",
        aktiv: false,
      },
    });
    expect(JSON.stringify(audit)).not.toContain("Erinnerung");
  });

  test("die Beschreibung ist optional, wird getrimmt und läuft nicht ins Audit-Log", async () => {
    const ohne = await legeRegelAn();
    expect((await zeile(ohne))?.beschreibung).toBeNull();
    const mit = await legeRegelAn(admin, {
      beschreibung: "  Bitte bis Freitag antworten  ",
    });
    expect((await zeile(mit))?.beschreibung).toBe(
      "Bitte bis Freitag antworten",
    );
    expect(JSON.stringify(await auditZeilen(mit))).not.toContain("Freitag");
    for (const beschreibung of ["   ", "x".repeat(301)]) {
      expect(
        (await anfrage(admin, "POST", BASIS, regelBody({ beschreibung })))
          .status,
      ).toBe(400);
    }
  });

  test("eine Stufe einer anderen Abteilung gibt 400 und schreibt nichts", async () => {
    const antwort = await anfrage(
      admin,
      "POST",
      BASIS,
      regelBody({ stufeId: welt.demoStufeId }),
    );
    expect(antwort.status).toBe(400);
  });

  test("Eltern bekommen 403", async () => {
    expect((await anfrage(eltern, "POST", BASIS, regelBody())).status).toBe(
      403,
    );
  });

  test.each([
    ["Wochentag 0", { wochentag: 0 }],
    ["Wochentag 8", { wochentag: 8 }],
    ["Wochentag als Text", { wochentag: "3" }],
    ["Uhrzeit 24:00", { uhrzeit: "24:00" }],
    ["Uhrzeit 8:00", { uhrzeit: "8:00" }],
    ["Uhrzeit 08:60", { uhrzeit: "08:60" }],
    ["leerer Text", { text: "   " }],
    ["Text mit 151 Zeichen", { text: "a".repeat(151) }],
    ["fehlendes aktiv", { aktiv: undefined }],
    ["abteilungId im Body", { abteilungId: "x" }],
  ])("%s gibt 400", async (_titel, extra) => {
    const antwort = await anfrage(admin, "POST", BASIS, regelBody(extra));
    expect(antwort.status).toBe(400);
  });
});

describe("GET /api/v1/admin/zeitregeln", () => {
  test("listet nur die Regeln der eigenen Abteilung, nach Wochentag und Uhrzeit", async () => {
    const spaet = await legeRegelAn(admin, { wochentag: 2, uhrzeit: "18:00" });
    const frueh = await legeRegelAn(admin, { wochentag: 2, uhrzeit: "07:00" });
    const demo = await legeRegelAn(demoAdmin, { wochentag: 1 });
    const antwort = await anfrage(admin, "GET", BASIS);
    expect(antwort.status).toBe(200);
    const { regeln } = (await antwort.json()) as {
      regeln: { id: string }[];
    };
    const ids = regeln.map((r) => r.id);
    expect(ids).not.toContain(demo);
    expect(ids.indexOf(frueh)).toBeLessThan(ids.indexOf(spaet));
    expect(regeln.find((r) => r.id === frueh)).toEqual({
      id: frueh,
      stufeId: null,
      wochentag: 2,
      uhrzeit: "07:00",
      text: "{Programm} am {Datum}: bitte antworten",
      beschreibung: null,
      aktiv: true,
    });
  });
});

describe("PATCH /api/v1/admin/zeitregeln/:id", () => {
  test("ändert nur die genannten Felder und schreibt das Audit-Log ohne Text", async () => {
    const id = await legeRegelAn(admin, { stufeId: welt.stufeAId });
    const antwort = await anfrage(admin, "PATCH", `${BASIS}/${id}`, {
      stufeId: null,
      uhrzeit: "09:15",
      text: "Neuer Text",
    });
    expect(antwort.status).toBe(204);
    expect(await zeile(id)).toMatchObject({
      stufeId: null,
      wochentag: 3,
      uhrzeit: "09:15",
      text: "Neuer Text",
      aktiv: true,
    });
    const [, audit] = await auditZeilen(id);
    expect(audit).toMatchObject({
      aktion: "zeitregel_geaendert",
      details: { stufeId: null, uhrzeit: "09:15", textGeaendert: true },
    });
    expect(JSON.stringify(audit)).not.toContain("Neuer Text");
  });

  test("die Beschreibung lässt sich setzen und mit null entfernen, ohne im Audit-Log zu stehen", async () => {
    const id = await legeRegelAn();
    expect(
      (
        await anfrage(admin, "PATCH", `${BASIS}/${id}`, {
          beschreibung: "Geheime Beschreibung",
        })
      ).status,
    ).toBe(204);
    expect((await zeile(id))?.beschreibung).toBe("Geheime Beschreibung");
    expect(
      (await anfrage(admin, "PATCH", `${BASIS}/${id}`, { beschreibung: null }))
        .status,
    ).toBe(204);
    expect((await zeile(id))?.beschreibung).toBeNull();
    const [, audit] = await auditZeilen(id);
    expect(audit).toMatchObject({ details: { textGeaendert: true } });
    expect(JSON.stringify(await auditZeilen(id))).not.toContain("Geheime");
  });

  test("ein leerer Body ändert nichts und schreibt kein Audit-Log", async () => {
    const id = await legeRegelAn();
    expect((await anfrage(admin, "PATCH", `${BASIS}/${id}`, {})).status).toBe(
      204,
    );
    expect(await auditZeilen(id)).toHaveLength(1);
  });

  test("eine Regel einer anderen Abteilung ist 404 und bleibt unverändert", async () => {
    const id = await legeRegelAn(demoAdmin);
    const antwort = await anfrage(admin, "PATCH", `${BASIS}/${id}`, {
      aktiv: false,
    });
    expect(antwort.status).toBe(404);
    expect((await zeile(id))!.aktiv).toBe(true);
  });

  test("Eltern bekommen 403, eine fremde Stufe 400", async () => {
    const id = await legeRegelAn();
    expect(
      (await anfrage(eltern, "PATCH", `${BASIS}/${id}`, { aktiv: false }))
        .status,
    ).toBe(403);
    expect(
      (
        await anfrage(admin, "PATCH", `${BASIS}/${id}`, {
          stufeId: welt.demoStufeId,
        })
      ).status,
    ).toBe(400);
    expect((await zeile(id))!.aktiv).toBe(true);
  });
});

describe("DELETE /api/v1/admin/zeitregeln/:id", () => {
  test("löscht die Regel samt gesendet-Zeilen und schreibt das Audit-Log", async () => {
    const id = await legeRegelAn();
    const [programm] = await db
      .insert(schema.programm)
      .values({
        abteilungId: welt.testabteilungId,
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

    expect((await anfrage(admin, "DELETE", `${BASIS}/${id}`)).status).toBe(204);
    expect(await zeile(id)).toBeUndefined();
    expect(
      await db
        .select()
        .from(schema.zeitregelGesendet)
        .where(eq(schema.zeitregelGesendet.regelId, id)),
    ).toEqual([]);
    const audit = await auditZeilen(id);
    expect(audit.map((a) => a.aktion)).toEqual([
      "zeitregel_angelegt",
      "zeitregel_geloescht",
    ]);
    expect((await anfrage(admin, "DELETE", `${BASIS}/${id}`)).status).toBe(404);
  });

  test("eine Regel einer anderen Abteilung ist 404, Eltern bekommen 403", async () => {
    const fremd = await legeRegelAn(demoAdmin);
    expect((await anfrage(admin, "DELETE", `${BASIS}/${fremd}`)).status).toBe(
      404,
    );
    const eigene = await legeRegelAn();
    expect((await anfrage(eltern, "DELETE", `${BASIS}/${eigene}`)).status).toBe(
      403,
    );
    expect(await zeile(fremd)).toBeDefined();
    expect(await zeile(eigene)).toBeDefined();
  });
});

describe("Stufe löschen", () => {
  test("nimmt die Regeln der Stufe mit, die anderen bleiben", async () => {
    const stufe = await anfrage(admin, "POST", "/api/v1/admin/stufen", {
      name: "Nur für Zeitregeln",
    });
    const { id: stufeId } = (await stufe.json()) as { id: string };
    const mit = await legeRegelAn(admin, { stufeId });
    const ohne = await legeRegelAn(admin);
    expect(
      (await anfrage(admin, "DELETE", `/api/v1/admin/stufen/${stufeId}`))
        .status,
    ).toBe(204);
    expect(await zeile(mit)).toBeUndefined();
    expect(await zeile(ohne)).toBeDefined();
  });
});
