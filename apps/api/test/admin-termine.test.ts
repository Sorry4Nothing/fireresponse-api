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
let eigener: string;
let fremder: string;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  kommando = await legePersonaAn(welt, "kommandoJfA");
  const jetzt = new Date("2031-05-01T18:00:00Z");
  eigener = (
    await legeProgrammAn(db, {
      einheitId: welt.einheit.jfA,
      titel: "Übung 1",
      beginn: jetzt,
    })
  ).id;
  await legeProgrammAn(db, {
    einheitId: welt.einheit.jfA,
    titel: "Zu spät",
    beginn: new Date("2032-05-01T18:00:00Z"),
  });
  fremder = (
    await legeProgrammAn(db, {
      einheitId: welt.einheit.kfA,
      beginn: jetzt,
    })
  ).id;
});

const basis = () => `/api/v1/admin/einheiten/${welt.einheit.jfA}/termine`;
const setze = (id: string, body: unknown, einheitId = welt.einheit.jfA) =>
  app.request(`/api/v1/admin/einheiten/${einheitId}/termine/${id}`, {
    method: "PUT",
    headers: { ...kommando.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const nurLeitende = async (id: string) =>
  (
    await db
      .select({ n: schema.programm.nurLeitende })
      .from(schema.programm)
      .where(eq(schema.programm.id, id))
  )[0]!.n;

describe("GET …/termine", () => {
  test("listet die Termine des Zeitraums mit Art und Schalter", async () => {
    const res = await app.request(`${basis()}?von=2031-01-01&bis=2031-12-31`, {
      headers: kommando.headers,
    });
    expect(res.status).toBe(200);
    const { termine } = (await res.json()) as {
      termine: { id: string; titel: string; nurLeitende: boolean }[];
    };
    expect(termine).toHaveLength(1);
    expect(termine[0]).toMatchObject({
      id: eigener,
      titel: "Übung 1",
      art: "Übung",
      nurLeitende: false,
    });
  });

  test("ohne oder mit ungültigem Zeitraum: 400", async () => {
    for (const q of ["", "?von=2031-01-01", "?von=x&bis=y"]) {
      const res = await app.request(`${basis()}${q}`, {
        headers: kommando.headers,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("PUT …/termine/:id", () => {
  test("setzt den Schalter und schreibt einen Audit-Eintrag; gleicher Wert ändert nichts", async () => {
    const audit = () =>
      db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.zielId, eigener));
    expect((await setze(eigener, { nurLeitende: true })).status).toBe(200);
    expect(await nurLeitende(eigener)).toBe(true);
    expect(await audit()).toHaveLength(1);
    expect((await setze(eigener, { nurLeitende: true })).status).toBe(200);
    expect(await audit()).toHaveLength(1);
    expect((await setze(eigener, { nurLeitende: false })).status).toBe(200);
    expect(await nurLeitende(eigener)).toBe(false);
  });

  test("Termin einer anderen Einheit: 404, unverändert", async () => {
    expect((await setze(fremder, { nurLeitende: true })).status).toBe(404);
    expect(await nurLeitende(fremder)).toBe(false);
  });

  test("fremde Felder und falsche Typen: 400", async () => {
    expect((await setze(eigener, { titel: "x" })).status).toBe(400);
    expect((await setze(eigener, { nurLeitende: "ja" })).status).toBe(400);
  });
});
