import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
import { legeProgrammAn } from "./hilfen/programme.js";

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
let kommando: PersonaKonto;
let admin: PersonaKonto;
// Die Arten der Termine in JF A: zwei Übungen, eine Sitzung, ein Kurs; ohne Art zählt nicht als Art
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  [kommando, admin] = await Promise.all([
    legePersonaAn(welt, "kommandoJfA"),
    legePersonaAn(welt, "kantonsadmin"),
  ]);
  const einheitId = welt.einheit.jfA;
  for (const art of ["Übung", "Übung", "Sitzung", "Kurs", null]) {
    await legeProgrammAn(db, { einheitId, art, anmeldbar: false });
  }
});

const pfad = (einheitId = welt.einheit.jfA) =>
  `/api/v1/admin/einheiten/${einheitId}/anmelde-arten`;
const anfrage = (
  konto: PersonaKonto,
  methode: "GET" | "PUT",
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
const gewaehlt = async () =>
  (
    await db
      .select({ a: schema.einheit.anmeldeArten })
      .from(schema.einheit)
      .where(eq(schema.einheit.id, welt.einheit.jfA))
  )[0]!.a;

describe("GET /api/v1/admin/einheiten/:einheitId/anmelde-arten", () => {
  test("zählt die Arten der Termine; ohne Entscheid ist keine anmeldbar", async () => {
    const res = await anfrage(kommando, "GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entschieden: false,
      arten: [
        { art: "Kurs", anzahl: 1, anmeldbar: false },
        { art: "Sitzung", anzahl: 1, anmeldbar: false },
        { art: "Übung", anzahl: 2, anmeldbar: false },
      ],
    });
  });
});

describe("PUT /api/v1/admin/einheiten/:einheitId/anmelde-arten", () => {
  test("speichert die Auswahl, antwortet mit dem neuen Stand und schreibt das Audit-Log", async () => {
    const res = await anfrage(kommando, "PUT", {
      arten: ["Übung", "Kurs", "Übung"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entschieden: true,
      arten: [
        { art: "Kurs", anzahl: 1, anmeldbar: true },
        { art: "Sitzung", anzahl: 1, anmeldbar: false },
        { art: "Übung", anzahl: 2, anmeldbar: true },
      ],
    });
    expect(await gewaehlt()).toEqual(["Kurs", "Übung"]);
    expect(await (await anfrage(admin, "GET")).json()).toMatchObject({
      entschieden: true,
    });

    const audit = (
      await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.zielId, welt.einheit.jfA))
    ).filter((a) => a.aktion === "anmelde_arten_gesetzt");
    expect(audit.at(-1)).toMatchObject({
      einheitId: welt.einheit.jfA,
      akteurId: kommando.id,
      zielTyp: "einheit",
      details: { arten: ["Kurs", "Übung"] },
    });
  });

  test("eine leere Auswahl ist ein Entscheid: keine Art anmeldbar", async () => {
    const res = await anfrage(kommando, "PUT", { arten: [] });
    expect(res.status).toBe(200);
    expect(await gewaehlt()).toEqual([]);
    expect(await res.json()).toMatchObject({ entschieden: true });
  });

  test("eine Art ohne Termine bleibt wählbar, solange sie gewählt ist, und lässt sich abwählen", async () => {
    await anfrage(kommando, "PUT", { arten: ["Übung"] });
    await db.delete(schema.programm).where(eq(schema.programm.art, "Kurs"));
    await db
      .update(schema.einheit)
      .set({ anmeldeArten: ["Kurs", "Übung"] })
      .where(eq(schema.einheit.id, welt.einheit.jfA));
    const stand = await (await anfrage(kommando, "GET")).json();
    expect(stand.arten).toContainEqual({
      art: "Kurs",
      anzahl: 0,
      anmeldbar: true,
    });
    const res = await anfrage(kommando, "PUT", { arten: ["Übung"] });
    expect(res.status).toBe(200);
    expect((await res.json()).arten.map((a: { art: string }) => a.art)).toEqual(
      ["Sitzung", "Übung"],
    );
  });

  test("eine Art, die bei der Einheit nicht vorkommt: 400, nichts ändert sich", async () => {
    await anfrage(kommando, "PUT", { arten: ["Übung"] });
    const res = await anfrage(kommando, "PUT", {
      arten: ["Übung", "Erfunden"],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "ART_UNBEKANNT" });
    expect(await gewaehlt()).toEqual(["Übung"]);
  });

  test.each([
    {},
    { arten: "Übung" },
    { arten: [""] },
    { arten: [5] },
    { arten: ["x".repeat(101)] },
    { arten: Array.from({ length: 51 }, (_, i) => `A${i}`) },
    { arten: [], extra: 1 },
  ])("lehnt den Body %j mit 400 ab", async (body) => {
    const res = await anfrage(kommando, "PUT", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "UNGUELTIGE_EINGABE" });
  });
});

describe("Mandantentrennung", () => {
  test("das Kommando einer anderen Einheit sieht die Arten nicht und ändert sie nicht (404)", async () => {
    await anfrage(kommando, "PUT", { arten: ["Übung"] });
    const fremd = await legePersonaAn(welt, "kommandoKfA");
    expect((await anfrage(fremd, "GET")).status).toBe(404);
    expect((await anfrage(fremd, "PUT", { arten: [] })).status).toBe(404);
    expect(await gewaehlt()).toEqual(["Übung"]);
  });

  test("Leitende und Eltern der Einheit: 403", async () => {
    for (const persona of ["leitendeJfA", "elternJfA"] as const) {
      const konto = await legePersonaAn(welt, persona);
      expect((await anfrage(konto, "GET")).status, persona).toBe(403);
      expect((await anfrage(konto, "PUT", { arten: [] })).status, persona).toBe(
        403,
      );
    }
  });
});
