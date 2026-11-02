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

const svg = (breite: number, hoehe: number) =>
  new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${breite} ${hoehe}"><rect width="${breite}" height="${hoehe}" fill="#0A1230"/></svg>`,
  );

let welt: Welt;
let kommando: PersonaKonto;
let leitende: PersonaKonto;
let fremd: PersonaKonto;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  [kommando, leitende, fremd] = await Promise.all([
    legePersonaAn(welt, "kommandoKfA"),
    legePersonaAn(welt, "leitendeJfA"),
    legePersonaAn(welt, "kommandoJfB"),
  ]);
});

const adminUrl = () => `/api/v1/admin/einheiten/${welt.einheit.kfA}/logo`;
const leseUrl = () => `/api/v1/einheiten/${welt.einheit.kfA}/logo`;
const senden = (
  konto: PersonaKonto,
  methode: string,
  url: string,
  body?: Uint8Array,
) =>
  app.request(url, {
    method: methode,
    headers: konto.headers,
    body: body as Uint8Array<ArrayBuffer> | undefined,
  });

describe("Einheitslogo", () => {
  test("ohne Logo: logoUrl ist null und das Lesen 404", async () => {
    expect((await senden(kommando, "GET", leseUrl())).status).toBe(404);
  });

  test("ein quadratisches SVG wird gespeichert, ausgeliefert und mit logoUrl gemeldet", async () => {
    expect(
      (await senden(kommando, "PUT", adminUrl(), svg(100, 100))).status,
    ).toBe(204);

    const bild = await senden(kommando, "GET", leseUrl());
    expect(bild.status).toBe(200);
    expect(bild.headers.get("content-type")).toBe("image/svg+xml");
    expect(bild.headers.get("x-content-type-options")).toBe("nosniff");

    const ich = (await (
      await senden(kommando, "GET", "/api/v1/ich")
    ).json()) as {
      einheiten: { id: string; logoUrl: string | null }[];
    };
    expect(
      ich.einheiten.find((e) => e.id === welt.einheit.kfA)?.logoUrl,
    ).toMatch(new RegExp(`^${leseUrl()}\\?v=[0-9a-f]{8}$`));
  });

  test("eine andere Einheit sieht das Logo nicht (404)", async () => {
    expect((await senden(fremd, "GET", leseUrl())).status).toBe(404);
  });

  test("ein Bild im Hochformat ist 415 LOGO_UNGUELTIG und ändert nichts", async () => {
    const antwort = await senden(kommando, "PUT", adminUrl(), svg(100, 130));
    expect(antwort.status).toBe(415);
    expect(((await antwort.json()) as { code: string }).code).toBe(
      "LOGO_UNGUELTIG",
    );
    expect((await senden(kommando, "GET", leseUrl())).status).toBe(200);
  });

  test("Leitende dürfen weder hochladen noch entfernen (403)", async () => {
    const url = `/api/v1/admin/einheiten/${welt.einheit.jfA}/logo`;
    expect((await senden(leitende, "PUT", url, svg(100, 100))).status).toBe(
      403,
    );
    expect((await senden(leitende, "DELETE", url)).status).toBe(403);
  });

  test("Entfernen löscht das Logo; ein zweites Mal ist ebenfalls 204", async () => {
    expect((await senden(kommando, "DELETE", adminUrl())).status).toBe(204);
    expect((await senden(kommando, "DELETE", adminUrl())).status).toBe(204);
    expect((await senden(kommando, "GET", leseUrl())).status).toBe(404);
    const [zeile] = await db
      .select({
        bild: schema.einheit.logoBild,
        typ: schema.einheit.logoBildTyp,
      })
      .from(schema.einheit)
      .where(eq(schema.einheit.id, welt.einheit.kfA));
    expect(zeile).toEqual({ bild: null, typ: null });
  });
});
