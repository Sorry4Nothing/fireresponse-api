import { eq } from "drizzle-orm";
import postgres from "postgres";
import sharp from "sharp";
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

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 130"><script>alert(1)</script><rect width="100" height="130" fill="#0A1230" onload="x()"/></svg>`;

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
    const id = await legeRangAn();
    const fremd = `/api/v1/admin/einheiten/${welt.einheit.jfA}/raenge/${id}`;
    expect(
      (await senden(konten.kommandoJfA, "PATCH", fremd, { name: "Neu" }))
        .status,
    ).toBe(404);
    expect((await senden(konten.kommandoJfA, "DELETE", fremd)).status).toBe(
      404,
    );
  });
});

describe("Ändern, Ordnen", () => {
  test("ändern mit Sternen, die Reihenfolge ist je Einheit eindeutig", async () => {
    const id = await legeRangAn({ abzeichenSterne: 2 });
    let rang = (await liste()).find((r) => r.id === id)!;
    expect(rang.abzeichen).toEqual({ art: "sterne", sterne: 2 });
    const neueReihenfolge = 500;
    expect(
      (
        await senden(kommando(), "PATCH", `${basis()}/${id}`, {
          name: "Umbenannt",
          abzeichenSterne: 1,
          reihenfolge: neueReihenfolge,
        })
      ).status,
    ).toBe(204);
    rang = (await liste()).find((r) => r.id === id)!;
    expect(rang).toMatchObject({
      name: "Umbenannt",
      reihenfolge: neueReihenfolge,
      abzeichen: { art: "sterne", sterne: 1 },
    });
    // Dieselbe Reihenfolge nochmals: 409 mit eigenem Code
    const zweiter = await legeRangAn();
    const doppelt = await senden(kommando(), "PATCH", `${basis()}/${zweiter}`, {
      reihenfolge: neueReihenfolge,
    });
    expect(doppelt.status).toBe(409);
    expect(await doppelt.json()).toMatchObject({
      code: "RANG_REIHENFOLGE_BELEGT",
    });
  });

  test("die Reihenfolge gilt je Typ: gleiche Zahl bei anderem Typ ist erlaubt, beim gleichen Typ nicht", async () => {
    const nr = 777;
    await legeRangAn({ typ: "miliz", reihenfolge: nr });
    const jf = await legeRangAn({ typ: "jf", reihenfolge: nr });
    const zweiter = await legeRangAn({ typ: "jf" });
    const doppelt = await senden(kommando(), "PATCH", `${basis()}/${zweiter}`, {
      reihenfolge: nr,
    });
    expect(doppelt.status).toBe(409);
    expect(
      (await senden(kommando(), "PATCH", `${basis()}/${jf}`, { typ: "miliz" }))
        .status,
    ).toBe(409);
  });

  test("Miliz-Ränge sind fest: ändern, löschen und ordnen gibt 403", async () => {
    const miliz = await legeRangAn({ typ: "miliz", name: "Major" });
    expect(
      (await senden(kommando(), "PATCH", `${basis()}/${miliz}`, { name: "X" }))
        .status,
    ).toBe(403);
    expect(
      (await senden(kommando(), "DELETE", `${basis()}/${miliz}`)).status,
    ).toBe(403);
    const ids = (await liste())
      .filter((r) => r.typ === "miliz")
      .map((r) => r.id);
    expect(
      (await senden(kommando(), "PUT", `${basis()}/reihenfolge`, { ids }))
        .status,
    ).toBe(403);
  });

  test("der Typ gilt je Rang: änderbar, nur kf, jf oder miliz", async () => {
    const ohne = await legeRangAn();
    const mitMiliz = await legeRangAn({ typ: "miliz", name: "Hauptmann" });
    const alle = await liste();
    expect(alle.find((r) => r.id === ohne)!.typ).toBe("kf");
    expect(alle.find((r) => r.id === mitMiliz)!.typ).toBe("miliz");
    expect(
      (
        await senden(kommando(), "PATCH", `${basis()}/${ohne}`, {
          typ: "jf",
        })
      ).status,
    ).toBe(204);
    expect((await liste()).find((r) => r.id === ohne)!.typ).toBe("jf");
    for (const typ of ["Miliz", "", "ff", null, 1]) {
      expect(
        (await senden(kommando(), "PATCH", `${basis()}/${ohne}`, { typ }))
          .status,
      ).toBe(400);
    }
  });

  test("ungültige Eingaben: Sterne über 2, Reihenfolge 0, leerer Name, fremde Felder", async () => {
    const id = await legeRangAn();
    const schlecht = [
      { reihenfolge: 1000 },
      { reihenfolge: 0 },
      { name: " " },
      { abzeichenSterne: 3 },
      { einheitId: welt.einheit.jfA },
    ];
    for (const body of schlecht) {
      expect(
        (await senden(kommando(), "PATCH", `${basis()}/${id}`, body)).status,
      ).toBe(400);
    }
    expect(
      (await senden(kommando(), "PATCH", `${basis()}/${id}`, {})).status,
    ).toBe(400);
  });

  test("umordnen schreibt Zehnerschritte in der gewünschten Reihenfolge und verlangt genau die Ränge der Einheit", async () => {
    const [a, b, c] = [
      await legeRangAn(),
      await legeRangAn(),
      await legeRangAn(),
    ];
    // Umgeordnet wird je Typ: hier die Kinderfeuerwehr-Ränge
    const alle = (await liste()).filter((r) => r.typ === "kf").map((r) => r.id);
    // Die drei neuen tauschen die Plätze am Ende: c, a, b
    const ids = [...alle.filter((id) => ![a, b, c].includes(id)), c, a, b];
    const ok = await senden(kommando(), "PUT", `${basis()}/reihenfolge`, {
      ids,
    });
    expect(ok.status).toBe(204);
    const jetzt = await liste();
    const kf = jetzt.filter((r) => r.typ === "kf");
    expect(kf.map((r) => r.id)).toEqual(ids);
    expect(kf.map((r) => r.reihenfolge)).toEqual(
      ids.map((_, i) => (i + 1) * 10),
    );
    // Ein Rang fehlt oder ist fremd
    expect(
      (
        await senden(kommando(), "PUT", `${basis()}/reihenfolge`, {
          ids: ids.slice(1),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await senden(kommando(), "PUT", `${basis()}/reihenfolge`, {
          ids: [...ids.slice(1), welt.rangId],
        })
      ).status,
    ).toBe(400);
  });
});

describe("Abzeichen", () => {
  test("ein SVG wird bereinigt gespeichert und mit sicheren Kopfzeilen ausgeliefert", async () => {
    const id = await legeRangAn({ abzeichenSterne: 2 });
    const antwort = await senden(
      kommando(),
      "PUT",
      `${basis()}/${id}/abzeichen`,
      new TextEncoder().encode(SVG),
    );
    expect(antwort.status).toBe(204);
    const rang = (await liste()).find((r) => r.id === id)!;
    // Sterne und Bild schliessen sich aus
    expect(rang.abzeichen).toMatchObject({ art: "bild", typ: "svg" });
    expect(rang.abzeichen?.url).toMatch(
      new RegExp(`^${basis()}/${id}/abzeichen\\?v=[0-9a-f]{8}$`),
    );
    const bild = await senden(kommando(), "GET", rang.abzeichen!.url!);
    expect(bild.status).toBe(200);
    expect(bild.headers.get("content-type")).toBe("image/svg+xml");
    expect(bild.headers.get("x-content-type-options")).toBe("nosniff");
    expect(bild.headers.get("content-security-policy")).toContain("sandbox");
    const text = await bild.text();
    expect(text).not.toContain("script");
    expect(text).not.toContain("onload");
    expect(text).toContain("<rect");
    // Gespeichert ist das bereinigte Ergebnis, nicht die Eingabe
    const [zeile] = await db
      .select({
        bild: schema.rang.abzeichenBild,
        typ: schema.rang.abzeichenBildTyp,
        sterne: schema.rang.abzeichenSterne,
      })
      .from(schema.rang)
      .where(eq(schema.rang.id, id));
    expect(zeile.typ).toBe("svg");
    expect(zeile.sterne).toBeNull();
    expect(new TextDecoder().decode(zeile.bild!)).toBe(text);
  });

  test("ein PNG wird angenommen; Sterne setzen das Bild wieder zurück", async () => {
    const id = await legeRangAn();
    const png = await sharp({
      create: { width: 200, height: 260, channels: 3, background: "#336" },
    })
      .png()
      .toBuffer();
    expect(
      (
        await senden(
          kommando(),
          "PUT",
          `${basis()}/${id}/abzeichen`,
          new Uint8Array(png),
        )
      ).status,
    ).toBe(204);
    const rang = (await liste()).find((r) => r.id === id)!;
    const bild = await senden(kommando(), "GET", rang.abzeichen!.url!);
    expect(bild.headers.get("content-type")).toBe("image/png");
    await senden(kommando(), "PATCH", `${basis()}/${id}`, {
      abzeichenSterne: 1,
    });
    expect((await liste()).find((r) => r.id === id)!.abzeichen).toEqual({
      art: "sterne",
      sterne: 1,
    });
    expect(
      (await senden(kommando(), "GET", `${basis()}/${id}/abzeichen`)).status,
    ).toBe(404);
  });

  test("Typ, Grösse und Inhalt: JPEG 415, 600 KB 413, kaputtes SVG 415, nichts wird gespeichert", async () => {
    const id = await legeRangAn();
    const url = `${basis()}/${id}/abzeichen`;
    const jpeg = await sharp({
      create: { width: 200, height: 260, channels: 3, background: "#336" },
    })
      .jpeg()
      .toBuffer();
    const falschesFormat = await senden(
      kommando(),
      "PUT",
      url,
      new Uint8Array(jpeg),
    );
    expect(falschesFormat.status).toBe(415);
    expect(await falschesFormat.json()).toMatchObject({
      code: "ABZEICHEN_UNGUELTIG",
    });
    const zuGross = await senden(
      kommando(),
      "PUT",
      url,
      new Uint8Array(600 * 1024).fill(0x20),
    );
    expect(zuGross.status).toBe(413);
    const kaputt = await senden(kommando(), "PUT", url, "<svg><rect/>");
    expect(kaputt.status).toBe(415);
    const doctype = await senden(
      kommando(),
      "PUT",
      url,
      '<!DOCTYPE svg [<!ENTITY a "b">]><svg viewBox="0 0 100 130"><rect/></svg>',
    );
    expect(doctype.status).toBe(415);
    const [zeile] = await db
      .select({ bild: schema.rang.abzeichenBild })
      .from(schema.rang)
      .where(eq(schema.rang.id, id));
    expect(zeile.bild).toBeNull();
  });

  test("entfernen löscht das Bild; ohne Bild 404", async () => {
    const id = await legeRangAn();
    await senden(
      kommando(),
      "PUT",
      `${basis()}/${id}/abzeichen`,
      new TextEncoder().encode(SVG),
    );
    expect(
      (await senden(kommando(), "DELETE", `${basis()}/${id}/abzeichen`)).status,
    ).toBe(204);
    expect((await liste()).find((r) => r.id === id)!.abzeichen).toBeNull();
    expect(
      (await senden(kommando(), "GET", `${basis()}/${id}/abzeichen`)).status,
    ).toBe(404);
  });
});

describe("Löschen", () => {
  test("ein zugeteilter Rang lässt sich nur mit einem Ziel löschen; die Personen wechseln mit", async () => {
    const alt = await legeRangAn();
    const ziel = await legeRangAn();
    const [person] = await db
      .insert(schema.teilnehmende)
      .values({
        einheitId: welt.einheit.kfA,
        vorname: "Rang",
        nachname: "Test",
        rangId: alt,
      })
      .returning({ id: schema.teilnehmende.id });
    const url = `${basis()}/${alt}`;
    const ohneZiel = await senden(kommando(), "DELETE", url);
    expect(ohneZiel.status).toBe(409);
    expect(await ohneZiel.json()).toMatchObject({ code: "RANG_IN_VERWENDUNG" });
    // Ein Ziel in einer anderen Einheit oder der Rang selbst ist ungültig
    expect(
      (
        await senden(
          kommando(),
          "DELETE",
          `${url}?verschiebenNach=${welt.rangId}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await senden(kommando(), "DELETE", `${url}?verschiebenNach=${alt}`))
        .status,
    ).toBe(400);
    expect(
      (await senden(kommando(), "DELETE", `${url}?verschiebenNach=${ziel}`))
        .status,
    ).toBe(204);
    const [danach] = await db
      .select({ rangId: schema.teilnehmende.rangId })
      .from(schema.teilnehmende)
      .where(eq(schema.teilnehmende.id, person.id));
    expect(danach.rangId).toBe(ziel);
    expect((await liste()).some((r) => r.id === alt)).toBe(false);
  });

  test("ein Rang ohne Personen wird sofort gelöscht", async () => {
    const id = await legeRangAn();
    expect(
      (await senden(kommando(), "DELETE", `${basis()}/${id}`)).status,
    ).toBe(204);
    expect((await liste()).some((r) => r.id === id)).toBe(false);
  });
});
