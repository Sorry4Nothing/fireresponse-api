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
import { stufenleitungDerStufen } from "../src/rechte.js";
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
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  admin = await legePersonaAn(welt, "admin");
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

const BASIS = "/api/v1/admin/stufen";
// Der Name ist pro Abteilung eindeutig, jede Stufe braucht darum ihren eigenen
let zaehler = 0;
const stufenBody = (extra: Record<string, unknown> = {}) => ({
  name: `Neue Stufe ${++zaehler}`,
  kuerzel: "NS",
  ...extra,
});

async function legeStufeAn(konto = admin, extra: Record<string, unknown> = {}) {
  const antwort = await anfrage(konto, "POST", BASIS, stufenBody(extra));
  expect(antwort.status).toBe(201);
  return ((await antwort.json()) as { id: string }).id;
}

const stufeZeile = async (id: string) =>
  (await db.select().from(schema.stufe).where(eq(schema.stufe.id, id)))[0];

describe("POST /api/v1/admin/stufen", () => {
  test("legt die Stufe in der Abteilung des Admins an, getrimmt", async () => {
    const id = await legeStufeAn(admin, {
      name: "  Pfadi  ",
      kuerzel: " P ",
    });
    expect(await stufeZeile(id)).toEqual({
      id,
      abteilungId: welt.testabteilungId,
      name: "Pfadi",
      kuerzel: "P",
    });
  });

  test("ohne Kürzel entsteht eine Stufe mit leerem Kürzel", async () => {
    const antwort = await anfrage(admin, "POST", BASIS, { name: "Eichhorn" });
    expect(antwort.status).toBe(201);
    const { id } = (await antwort.json()) as { id: string };
    expect(await stufeZeile(id)).toMatchObject({
      name: "Eichhorn",
      kuerzel: "",
    });
  });

  test("ein vergebener Name gibt 409, auch in anderer Schreibweise", async () => {
    await legeStufeAn(admin, { name: "Fuchs" });
    for (const name of ["Fuchs", " fuchs "]) {
      const antwort = await anfrage(admin, "POST", BASIS, { name });
      expect(antwort.status).toBe(409);
      expect(await antwort.json()).toMatchObject({
        code: "STUFENNAME_VERGEBEN",
      });
    }
  });

  test("derselbe Name in einer anderen Abteilung ist erlaubt", async () => {
    const demoAdmin = await legePersonaAn(welt, "demoAdmin");
    await legeStufeAn(admin, { name: "Wolf" });
    await legeStufeAn(demoAdmin, { name: "Wolf" });
  });

  test("der Demo-Admin legt in der Demo-Abteilung an", async () => {
    const demoAdmin = await legePersonaAn(welt, "demoAdmin");
    const id = await legeStufeAn(demoAdmin);
    expect((await stufeZeile(id)).abteilungId).toBe(welt.demoAbteilungId);
  });

  test("ein Name, den eine andere Stufe trägt, gibt 409", async () => {
    await legeStufeAn(admin, { name: "Rover" });
    const id = await legeStufeAn(admin, { name: "Pio A" });
    const antwort = await anfrage(admin, "PATCH", `${BASIS}/${id}`, {
      name: "rover",
    });
    expect(antwort.status).toBe(409);
    expect((await stufeZeile(id)).name).toBe("Pio A");
  });

  test("die eigene Stufe unter demselben Namen zu speichern ist kein Konflikt", async () => {
    const id = await legeStufeAn(admin, { name: "Pio B" });
    const antwort = await anfrage(admin, "PATCH", `${BASIS}/${id}`, {
      name: "Pio B",
    });
    expect(antwort.status).toBe(204);
  });

  test("benennt um und ändert das Kürzel einzeln", async () => {
    const id = await legeStufeAn();
    expect(
      (await anfrage(admin, "PATCH", `${BASIS}/${id}`, { name: " Biber " }))
        .status,
    ).toBe(204);
    expect(await stufeZeile(id)).toMatchObject({
      name: "Biber",
      kuerzel: "NS",
    });
    await anfrage(admin, "PATCH", `${BASIS}/${id}`, { kuerzel: "B" });
    expect(await stufeZeile(id)).toMatchObject({ name: "Biber", kuerzel: "B" });
  });

  test("ein leerer Body ist ein No-op mit 204", async () => {
    const id = await legeStufeAn();
    const vorher = await stufeZeile(id);
    expect((await anfrage(admin, "PATCH", `${BASIS}/${id}`, {})).status).toBe(
      204,
    );
    expect(await stufeZeile(id)).toEqual(vorher);
  });

  test.each([
    ["abteilungId", { abteilungId: randomUUID() }],
    ["leerer Name", { name: " " }],
    ["Reihenfolge (entfallen)", { reihenfolge: 3 }],
  ])("%s gibt 400", async (_titel, body) => {
    const id = await legeStufeAn();
    expect((await anfrage(admin, "PATCH", `${BASIS}/${id}`, body)).status).toBe(
      400,
    );
  });

  test("eine ID, die keine UUID ist, gibt 400", async () => {
    expect(
      (await anfrage(admin, "PATCH", `${BASIS}/gibt-es-nicht`, { name: "X" }))
        .status,
    ).toBe(400);
  });

  test("unbekannte Stufe 404; der Demo-Admin auf eine Stufe der Testabteilung 404, ohne sie zu ändern", async () => {
    const demoAdmin = await legePersonaAn(welt, "demoAdmin");
    expect(
      (await anfrage(admin, "PATCH", `${BASIS}/${randomUUID()}`, { name: "X" }))
        .status,
    ).toBe(404);
    expect(
      (
        await anfrage(demoAdmin, "PATCH", `${BASIS}/${welt.stufeAId}`, {
          name: "Fremd",
        })
      ).status,
    ).toBe(404);
    expect((await stufeZeile(welt.stufeAId)).name).toBe("Stufe A");
  });

  test("kein Admin: 403 ohne Änderung", async () => {
    const sl = await legePersonaAn(welt, "slA");
    const id = await legeStufeAn(admin, { name: "Unverändert" });
    expect(
      (await anfrage(sl, "PATCH", `${BASIS}/${id}`, { name: "Verboten" }))
        .status,
    ).toBe(403);
    expect((await stufeZeile(id)).name).toBe("Unverändert");
  });
});

describe("DELETE /api/v1/admin/stufen/:id", () => {
  test("löscht die leere Stufe und schreibt das Audit-Log", async () => {
    const id = await legeStufeAn();
    const antwort = await anfrage(admin, "DELETE", `${BASIS}/${id}`);
    expect(antwort.status).toBe(204);
    expect(await stufeZeile(id)).toBeUndefined();
    const [eintrag] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.zielId, id));
    expect(eintrag).toMatchObject({
      aktion: "stufe_geloescht",
      zielTyp: "stufe",
      akteurId: admin.id,
      abteilungId: welt.testabteilungId,
    });
  });

  test("mit einem Kind (auch inaktiv): 409 STUFE_BELEGT, nichts ändert sich", async () => {
    const id = await legeStufeAn();
    await db.insert(schema.kind).values({
      abteilungId: welt.testabteilungId,
      vorname: "Test",
      nachname: "Kind",
      stufeId: id,
      inaktivSeit: new Date(),
    });
    const antwort = await anfrage(admin, "DELETE", `${BASIS}/${id}`);
    expect(antwort.status).toBe(409);
    expect(((await antwort.json()) as { code: string }).code).toBe(
      "STUFE_BELEGT",
    );
    expect(await stufeZeile(id)).toBeDefined();
  });

  test("mit Leitung: 409 STUFE_BELEGT", async () => {
    const id = await legeStufeAn();
    const leitung = await legePersonaAn(welt, "slA");
    await db
      .insert(schema.rolle)
      .values({ userId: leitung.id!, stufeId: id, typ: "leitung" });
    const antwort = await anfrage(admin, "DELETE", `${BASIS}/${id}`);
    expect(antwort.status).toBe(409);
    expect(await stufeZeile(id)).toBeDefined();
  });

  test("unbekannte Stufe 404; die Demo-Abteilung erreicht die Stufe der Testabteilung nicht", async () => {
    expect(
      (await anfrage(admin, "DELETE", `${BASIS}/${randomUUID()}`)).status,
    ).toBe(404);
    const id = await legeStufeAn();
    const demo = await legePersonaAn(welt, "demoAdmin");
    expect((await anfrage(demo, "DELETE", `${BASIS}/${id}`)).status).toBe(404);
    expect(await stufeZeile(id)).toBeDefined();
  });

  test("kein Admin: 403, die Stufe bleibt", async () => {
    const id = await legeStufeAn();
    const sl = await legePersonaAn(welt, "slA");
    expect((await anfrage(sl, "DELETE", `${BASIS}/${id}`)).status).toBe(403);
    expect(await stufeZeile(id)).toBeDefined();
  });
});

describe("GET /api/v1/stufen", () => {
  type Eintrag = {
    id: string;
    name: string;
    kuerzel: string;
  };
  const liste = async (konto: PersonaKonto) => {
    const antwort = await anfrage(konto, "GET", "/api/v1/stufen");
    expect(antwort.status).toBe(200);
    return ((await antwort.json()) as { stufen: Eintrag[] }).stufen;
  };

  test("liefert Eltern und Admin dieselben Stufen der eigenen Abteilung: id, name, kuerzel", async () => {
    const eltern = await legePersonaAn(welt, "elternA");
    const [fuerEltern, fuerAdmin] = [await liste(eltern), await liste(admin)];
    expect(fuerEltern).toEqual(fuerAdmin);
    expect(
      fuerEltern.filter((s) => [welt.stufeAId, welt.stufeBId].includes(s.id)),
    ).toEqual([
      {
        id: welt.stufeAId,
        name: "Stufe A",
        kuerzel: "A",
      },
      {
        id: welt.stufeBId,
        name: "Stufe B",
        kuerzel: "B",
      },
    ]);
    expect(fuerEltern.map((s) => s.id)).not.toContain(welt.demoStufeId);
  });

  test("die Demo-Abteilung sieht nur Stufen der Demo-Abteilung", async () => {
    const demoEltern = await legePersonaAn(welt, "demoEltern");
    const ids = (await liste(demoEltern)).map((s) => s.id);
    expect(ids).toContain(welt.demoStufeId);
    expect(ids).not.toContain(welt.stufeAId);
    expect(ids).not.toContain(welt.stufeBId);
  });

  test("sortiert nach Name, ohne Feld «reihenfolge»", async () => {
    const z = randomUUID();
    await legeStufeAn(admin, { name: `Zz ${z}` });
    await legeStufeAn(admin, { name: `Aa ${z}` });
    await legeStufeAn(admin, { name: `Mm ${z}` });
    const stufen = await liste(admin);
    expect(stufen.map((s) => s.name).filter((n) => n.endsWith(z))).toEqual([
      `Aa ${z}`,
      `Mm ${z}`,
      `Zz ${z}`,
    ]);
    expect(stufen.every((s) => !("reihenfolge" in s))).toBe(true);
  });
});

describe("PUT /api/v1/admin/stufen/:id/stufenleitung", () => {
  // Zwei SL und eine Leitung in einer frischen Stufe
  async function stufeMitSl() {
    const id = await legeStufeAn();
    const [a, b, leitung] = await Promise.all(
      (["slA", "slA", "leitendeA"] as const).map((p) => legePersonaAn(welt, p)),
    );
    await db.insert(schema.rolle).values([
      { userId: a.id!, stufeId: id, typ: "stufenleitung" },
      { userId: b.id!, stufeId: id, typ: "stufenleitung" },
      { userId: leitung.id!, stufeId: id, typ: "leitung" },
    ]);
    return { id, a: a.id!, b: b.id!, leitung: leitung.id! };
  }
  const prioritaeten = async (stufeId: string) =>
    Object.fromEntries(
      (
        await db
          .select()
          .from(schema.rolle)
          .where(eq(schema.rolle.stufeId, stufeId))
      ).map((r) => [r.userId, r.prioritaet]),
    );
  const reihenfolge = async (stufeId: string) =>
    (await stufenleitungDerStufen(db, welt.testabteilungId, [stufeId])).map(
      (z) => z.id,
    );

  test("setzt die Reihenfolge; die Kontakte kommen so, wer fehlt, steht hinten", async () => {
    const s = await stufeMitSl();
    const put = (ids: string[]) =>
      anfrage(admin, "PUT", `${BASIS}/${s.id}/stufenleitung`, { ids });
    expect((await put([s.b, s.a])).status).toBe(204);
    expect(await prioritaeten(s.id)).toMatchObject({ [s.b]: 1, [s.a]: 2 });
    expect(await reihenfolge(s.id)).toEqual([s.b, s.a]);
    expect((await put([s.a])).status).toBe(204);
    expect(await prioritaeten(s.id)).toMatchObject({ [s.a]: 1, [s.b]: null });
    expect(await reihenfolge(s.id)).toEqual([s.a, s.b]);
    const eintraege = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.zielId, s.id));
    expect(eintraege.map((e) => e.aktion)).toEqual([
      "sl_reihenfolge_geaendert",
      "sl_reihenfolge_geaendert",
    ]);
  });

  test("Leitung, Fremde und Doppelte: 400, nichts ändert sich", async () => {
    const s = await stufeMitSl();
    const fremd = (await legePersonaAn(welt, "slB")).id!;
    for (const ids of [
      [s.a, s.leitung],
      [s.a, fremd],
      [s.a, s.a],
      [randomUUID()],
    ]) {
      const r = await anfrage(admin, "PUT", `${BASIS}/${s.id}/stufenleitung`, {
        ids,
      });
      expect(r.status).toBe(400);
    }
    expect(await prioritaeten(s.id)).toMatchObject({
      [s.a]: null,
      [s.b]: null,
    });
  });

  test("unbekannte Stufe und Demo-Abteilung 404, SL 403", async () => {
    const s = await stufeMitSl();
    const pfad = (id: string) => `${BASIS}/${id}/stufenleitung`;
    expect(
      (await anfrage(admin, "PUT", pfad(randomUUID()), { ids: [] })).status,
    ).toBe(404);
    const demo = await legePersonaAn(welt, "demoAdmin");
    expect(
      (await anfrage(demo, "PUT", pfad(s.id), { ids: [s.a] })).status,
    ).toBe(404);
    const sl = await legePersonaAn(welt, "slA");
    expect((await anfrage(sl, "PUT", pfad(s.id), { ids: [s.a] })).status).toBe(
      403,
    );
    expect(await prioritaeten(s.id)).toMatchObject({ [s.a]: null });
  });
});
