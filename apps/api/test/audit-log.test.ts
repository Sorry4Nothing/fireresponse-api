import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
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
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  admin = await legePersonaAn(welt, "admin");
});

// Jede Anfrage schreibt sonst eine Log-Zeile in die Testausgabe
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const BASIS = "/api/v1/admin/personen";

function anfrage(methode: string, pfad = "", body?: Record<string, unknown>) {
  return app.request(`${BASIS}${pfad}`, {
    method: methode,
    headers: body
      ? { ...admin.headers, "content-type": "application/json" }
      : admin.headers,
    body: body && JSON.stringify(body),
  });
}

async function legePersonAn(extra: Record<string, unknown> = {}) {
  const antwort = await anfrage("POST", "", {
    vorname: "Vreni",
    nachname: "Muster",
    benutzername: `person.${randomUUID().slice(0, 8)}`,
    admin: false,
    rollen: [],
    elternteilVon: [],
    ...extra,
  });
  expect(antwort.status).toBe(201);
  return (await antwort.json()) as { id: string };
}

const eintraege = (zielId: string) =>
  db
    .select({
      aktion: schema.auditLog.aktion,
      akteurId: schema.auditLog.akteurId,
      abteilungId: schema.auditLog.abteilungId,
      zielTyp: schema.auditLog.zielTyp,
      details: schema.auditLog.details,
    })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.zielId, zielId))
    .orderBy(asc(schema.auditLog.erstelltAm), asc(schema.auditLog.id));

const vomAdmin = (aktion: string, details: unknown = null) => ({
  aktion,
  akteurId: admin.id,
  abteilungId: welt.testabteilungId,
  zielTyp: "person",
  details,
});

test("Person anlegen schreibt «person_angelegt» ohne Personendaten", async () => {
  const { id } = await legePersonAn({
    admin: true,
    rollen: [{ stufeId: welt.stufeAId, typ: "leitung" }],
  });
  const log = await eintraege(id);
  expect(log).toEqual([
    vomAdmin("person_angelegt", {
      admin: true,
      rollen: [{ stufeId: welt.stufeAId, typ: "leitung" }],
      elternteilVon: [],
    }),
  ]);
  expect(JSON.stringify(log)).not.toMatch(/Vreni|Muster|person\./);
});

test("Telefon ändern schreibt «telefon_geaendert» ohne die Nummer; gleiche Nummer schreibt nichts", async () => {
  const { id } = await legePersonAn({
    rollen: [{ stufeId: welt.stufeAId, typ: "stufenleitung" }],
  });
  const patch = async (telefon: string | null) =>
    expect((await anfrage("PATCH", `/${id}`, { telefon })).status).toBe(204);
  await patch("044 123 45 67");
  await patch("044 123 45 67");
  await patch(null);
  const log = await eintraege(id);
  expect(log.slice(1)).toEqual([
    vomAdmin("telefon_geaendert", { telefon: "gesetzt" }),
    vomAdmin("telefon_geaendert", { telefon: "entfernt" }),
  ]);
  expect(JSON.stringify(log)).not.toMatch(/044/);
});

test("Rollen ändern schreibt «rolle_geaendert» mit den geänderten Schlüsseln; Name und No-op schreiben nichts", async () => {
  const { id } = await legePersonAn({
    rollen: [{ stufeId: welt.stufeAId, typ: "leitung" }],
  });
  const patch = async (body: Record<string, unknown>) =>
    expect((await anfrage("PATCH", `/${id}`, body)).status).toBe(204);

  await patch({ name: "Vreni Neu" });
  await patch({
    admin: false,
    rollen: [{ stufeId: welt.stufeAId, typ: "leitung" }],
    elternteilVon: [],
  });
  expect((await eintraege(id)).map((e) => e.aktion)).toEqual([
    "person_angelegt",
  ]);

  await patch({ admin: true });
  await patch({ rollen: [{ stufeId: welt.stufeAId, typ: "stufenleitung" }] });
  await patch({ elternteilVon: [welt.kindBId] });
  expect((await eintraege(id)).slice(1)).toEqual([
    vomAdmin("rolle_geaendert", { admin: true }),
    vomAdmin("rolle_geaendert", {
      rollen: [{ stufeId: welt.stufeAId, typ: "stufenleitung" }],
    }),
    vomAdmin("rolle_geaendert", { elternteilVon: [welt.kindBId] }),
  ]);
});

test("Startpasswort neu, Deaktivieren, Aktivieren und Löschen schreiben je einen Eintrag; der Eintrag über die gelöschte Person bleibt", async () => {
  const { id } = await legePersonAn();
  for (const pfad of ["/startpasswort", "/deaktivieren", "/aktivieren"]) {
    expect((await anfrage("POST", `/${id}${pfad}`)).status).toBeLessThan(300);
  }
  expect((await anfrage("DELETE", `/${id}`)).status).toBe(204);
  expect((await eintraege(id)).slice(1)).toEqual([
    vomAdmin("startpasswort_neu"),
    vomAdmin("person_deaktiviert"),
    vomAdmin("person_aktiviert"),
    vomAdmin("person_geloescht"),
  ]);
});

test("eine verweigerte Aktion schreibt keinen Eintrag", async () => {
  const { id } = await legePersonAn();
  expect((await anfrage("POST", `/${admin.id}/deaktivieren`)).status).toBe(409);
  expect(await eintraege(String(admin.id))).toEqual([]);
  expect(await eintraege(id)).toHaveLength(1);
});
