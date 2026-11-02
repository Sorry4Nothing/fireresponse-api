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
  type Persona,
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

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

// Eine Welt und die Personas einmal: Die Tests legen ihre Ränge in einer eigenen Einheit an (KF A), damit sie sich nicht stören
let welt: Welt;
let konten: Record<
  "kantonsadmin" | "kommandoKfA" | "kommandoJfA" | "leitendeJfA" | "stv",
  PersonaKonto
>;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  const hole = (p: Persona) => legePersonaAn(welt, p);
  const [kantonsadmin, kommandoKfA, kommandoJfA, leitendeJfA, stv] =
    await Promise.all([
      hole("kantonsadmin"),
      hole("kommandoKfA"),
      hole("kommandoJfA"),
      hole("leitendeJfA"),
      hole("stellvertretung1JfA"),
    ]);
  konten = { kantonsadmin, kommandoKfA, kommandoJfA, leitendeJfA, stv };
});

const basis = () => `/api/v1/admin/einheiten/${welt.einheit.kfA}/raenge`;

function senden(
  konto: PersonaKonto,
  methode: string,
  url: string,
  body?: unknown,
) {
  const roh = body instanceof Uint8Array || typeof body === "string";
  return app.request(url, {
    method: methode,
    headers: {
      ...konto.headers,
      ...(body !== undefined && !roh && { "content-type": "application/json" }),
    },
    body: roh
      ? (body as Uint8Array<ArrayBuffer> | string)
      : body === undefined
        ? undefined
        : JSON.stringify(body),
  });
}

const kommando = () => konten.kommandoKfA;

let zaehler = 0;
// Ränge legt nur das Backend an; die Tests schreiben sie direkt in die Datenbank (KF A: Typ kf)
async function legeRangAn(
  extra: Partial<typeof schema.rang.$inferInsert> = {},
) {
  const [zeile] = await db
    .insert(schema.rang)
    .values({
      einheitId: welt.einheit.kfA,
      name: `Rang ${++zaehler}`,
      kuerzel: `R${zaehler}`,
      typ: "kf",
      reihenfolge: 100 + zaehler,
      ...extra,
    })
    .returning({ id: schema.rang.id });
  return zeile.id;
}

const liste = async (k = kommando()) =>
  (
    (await (await senden(k, "GET", basis())).json()) as {
      raenge: {
        id: string;
        name: string;
        typ: string;
        reihenfolge: number;
        abzeichen: null | {
          art: string;
          sterne?: number;
          url?: string;
          typ?: string;
        };
        teilnehmende: number;
        rollen: number;
      }[];
    }
  ).raenge;

const SVG_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 130"><rect width="100" height="130" fill="#0A1230"/></svg>',
);

describe("Rechte", () => {
  test("Kommando, Stellvertretung und Kantonsadmin sehen und ändern die Ränge, Leitende und andere Einheiten nicht", async () => {
    const lesen = (k: PersonaKonto) => senden(k, "GET", basis());
    expect((await lesen(konten.kommandoKfA)).status).toBe(200);
    expect((await lesen(konten.kantonsadmin)).status).toBe(200);
    // Kommando von JF A kennt KF A nicht
    expect((await lesen(konten.kommandoJfA)).status).toBe(404);
    // Leitende der Einheit sehen sie, dürfen aber nichts; hier hat KF A keine Leitung, JF A schon
    const jfA = `/api/v1/admin/einheiten/${welt.einheit.jfA}/raenge`;
    expect((await senden(konten.leitendeJfA, "GET", jfA)).status).toBe(403);
    expect((await senden(konten.stv, "GET", jfA)).status).toBe(200);
  });

  test("Ränge lassen sich über die API nicht anlegen", async () => {
    const body = { name: "X", kuerzel: "X", reihenfolge: 50 };
    for (const k of [konten.kommandoKfA, konten.kantonsadmin]) {
      expect((await senden(k, "POST", basis(), body)).status).toBe(404);
    }
  });

  test("ein Rang einer anderen Einheit ist 404, auch mit gültiger ID", async () => {
    const id = await legeRangAn({
      abzeichenBild: SVG_BYTES,
      abzeichenBildTyp: "svg",
    });
    const fremd = `/api/v1/admin/einheiten/${welt.einheit.jfA}/raenge/${id}/abzeichen`;
    expect((await senden(konten.kommandoJfA, "GET", fremd)).status).toBe(404);
  });
});

describe("Ränge sind fest", () => {
  test("ändern, ordnen, löschen und Abzeichen setzen gibt es über die API nicht", async () => {
    const id = await legeRangAn();
    const ids = [id];
    const anfragen: [string, string, unknown?][] = [
      ["PATCH", `${basis()}/${id}`, { name: "Neu" }],
      ["DELETE", `${basis()}/${id}`],
      ["PUT", `${basis()}/reihenfolge`, { ids }],
      ["PUT", `${basis()}/${id}/abzeichen`, SVG_BYTES],
      ["DELETE", `${basis()}/${id}/abzeichen`],
    ];
    for (const [methode, url, body] of anfragen) {
      expect((await senden(kommando(), methode, url, body)).status).toBe(404);
    }
    const rang = (await liste()).find((r) => r.id === id)!;
    expect(rang.name).not.toBe("Neu");
  });

  test("die Liste nennt das Abzeichen; das Bild kommt mit sicheren Kopfzeilen", async () => {
    const id = await legeRangAn({
      abzeichenBild: SVG_BYTES,
      abzeichenBildTyp: "svg",
    });
    const rang = (await liste()).find((r) => r.id === id)!;
    expect(rang.abzeichen).toMatchObject({ art: "bild", typ: "svg" });
    expect(rang.abzeichen?.url).toMatch(
      new RegExp(`^${basis()}/${id}/abzeichen\\?v=[0-9a-f]{8}$`),
    );
    const bild = await senden(kommando(), "GET", rang.abzeichen!.url!);
    expect(bild.status).toBe(200);
    expect(bild.headers.get("content-type")).toBe("image/svg+xml");
    expect(bild.headers.get("x-content-type-options")).toBe("nosniff");
    expect(bild.headers.get("content-security-policy")).toContain("sandbox");
    // Ohne eigenes Bild: 404
    const ohne = await legeRangAn();
    expect(
      (await senden(kommando(), "GET", `${basis()}/${ohne}/abzeichen`)).status,
    ).toBe(404);
  });
});
