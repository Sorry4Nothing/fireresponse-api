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
import {
  bereiteAuthTestsVor,
  erstelleTestAuth,
  fcmNachricht,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  type Persona,
  type PersonaKonto,
  type Welt,
} from "./hilfen/personas.js";
import { legeProgrammAn } from "./hilfen/programme.js";

const fcmAttrappe = bereiteAuthTestsVor();

const sql = postgres(API_URL);
const db = erstelleDb(sql);
const auth = erstelleTestAuth(db);
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  fcm: fcmAttrappe,
  // Die Termine liegen 2027, das Fenster ist darum weit offen
  anmeldefensterTage: 800,
  seiten: ladeSeiten(),
});
afterAll(() => sql.end());

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
  fcmAttrappe.zuruecksetzen();
});
afterEach(() => ausgabe.mockRestore());

// Die Personen der Einheit JF A: fünf Leitende, dazu Eltern und das Kantonsadmin-Konto
const LEITENDE = [
  "kommandoJfA",
  "stellvertretung1JfA",
  "stellvertretung2JfA",
  "leitendeJfA",
  "leitendeJfAElternKfA",
] as const;
const PERSONEN: Persona[] = [...LEITENDE, "elternJfA", "kantonsadmin"];

let welt: Welt;
const konten = new Map<Persona, PersonaKonto>();
const konto = (p: Persona) => konten.get(p)!;
const tokens = new Map<Persona, string>();

beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  for (const p of PERSONEN) konten.set(p, await legePersonaAn(welt, p));
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const aufruf = (
  p: Persona,
  methode: "GET" | "PUT" | "POST" | "DELETE",
  pfad: string,
  body?: unknown,
) =>
  app.request(pfad, {
    method: methode,
    headers: { ...konto(p).headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (antwort: Response) => (await antwort.json()) as Json;

// Ein Termin der Quelle manuell am Samstag, 6.3.2027 (14:00 Schweizer Zeit)
async function termin(hoechstzahl: number | null, titel = "Waldtag") {
  const p = await legeProgrammAn(db, { einheitId: welt.einheit.jfA, titel });
  await db
    .update(schema.programm)
    .set({ quelle: "manuell", leitungHoechstzahl: hoechstzahl })
    .where(eq(schema.programm.id, p.id));
  return p.id;
}

const leitung = (p: Persona, id: string, status: "ja" | "nein") =>
  aufruf(p, "PUT", `/api/v1/programme/${id}/leitung`, { status });
const antwort = async (p: Persona, id: string, status: "ja" | "nein") => {
  const res = await leitung(p, id, status);
  expect(res.status).toBe(200);
  return json(res);
};
const teilnahmen = async (p: Persona, id: string) =>
  json(await aufruf(p, "GET", `/api/v1/programme/${id}/teilnahmen`));
const detail = async (p: Persona, id: string) =>
  json(await aufruf(p, "GET", `/api/v1/programme/${id}`));
const adminAendern = (id: string, body: unknown) =>
  aufruf(
    "kommandoJfA",
    "PUT",
    `/api/v1/admin/einheiten/${welt.einheit.jfA}/termine/${id}`,
    body,
  );

async function registriereToken(p: Persona) {
  const wert = `fcm-test-${randomUUID()}`;
  const res = await aufruf(p, "PUT", "/api/v1/push-token", {
    token: wert,
    plattform: "android",
  });
  expect(res.status).toBe(204);
  tokens.set(p, wert);
  return wert;
}

describe("PUT /programme/:id/leitung mit Höchstzahl", () => {
  test("Zusagen belegen Plätze, weitere kommen der Reihe nach auf die Warteliste; Wiederholen ändert nichts", async () => {
    const id = await termin(2);
    expect(await antwort("kommandoJfA", id, "ja")).toEqual({
      status: "ja",
      position: null,
    });
    expect(await antwort("stellvertretung1JfA", id, "ja")).toEqual({
      status: "ja",
      position: null,
    });
    expect(await antwort("stellvertretung2JfA", id, "ja")).toEqual({
      status: "warteliste",
      position: 1,
    });
    expect(await antwort("leitendeJfA", id, "ja")).toEqual({
      status: "warteliste",
      position: 2,
    });
    // Wiederholen behält den Platz in der Reihe
    expect(await antwort("stellvertretung2JfA", id, "ja")).toEqual({
      status: "warteliste",
      position: 1,
    });
    expect(await antwort("kommandoJfA", id, "ja")).toEqual({
      status: "ja",
      position: null,
    });
  });

  test("Absage von der Warteliste trägt aus und lässt die übrigen aufrücken; die Reihenfolge der Eintragung gilt", async () => {
    const id = await termin(1);
    await antwort("kommandoJfA", id, "ja");
    await antwort("stellvertretung1JfA", id, "ja");
    await antwort("stellvertretung2JfA", id, "ja");
    await antwort("leitendeJfA", id, "ja");
    expect(await antwort("stellvertretung1JfA", id, "nein")).toEqual({
      status: "nein",
      position: null,
    });
    const liste = await teilnahmen("kommandoJfA", id);
    const status = (name: string) =>
      liste.leitende.find((l: Json) => l.id === konto(name as Persona).id);
    expect(status("stellvertretung2JfA")).toMatchObject({
      status: "warteliste",
      position: 1,
    });
    expect(status("leitendeJfA")).toMatchObject({
      status: "warteliste",
      position: 2,
    });
    expect(status("stellvertretung1JfA")).toMatchObject({ status: "nein" });
  });

  test("Absage eines Platzes: die erste wartende Person rückt nach und bekommt einen Push, sonst niemand", async () => {
    const id = await termin(1);
    const [t2, t3, tKommando] = await Promise.all([
      registriereToken("stellvertretung2JfA"),
      registriereToken("leitendeJfA"),
      registriereToken("kommandoJfA"),
    ]);
    await antwort("kommandoJfA", id, "ja");
    await antwort("stellvertretung2JfA", id, "ja");
    await antwort("leitendeJfA", id, "ja");
    fcmAttrappe.zuruecksetzen();

    expect(await antwort("kommandoJfA", id, "nein")).toEqual({
      status: "nein",
      position: null,
    });

    expect(fcmAttrappe.nachrichten).toStrictEqual([
      fcmNachricht(
        t2,
        "Du bist nachgerückt",
        { typ: "programm", id },
        "termine",
        "Waldtag am Sa 6.3.",
      ),
    ]);
    expect(fcmAttrappe.nachrichten.map((n) => n.token)).not.toContain(t3);
    expect(fcmAttrappe.nachrichten.map((n) => n.token)).not.toContain(
      tKommando,
    );
    const liste = await teilnahmen("kommandoJfA", id);
    expect(
      liste.leitende.find(
        (l: Json) => l.id === konto("stellvertretung2JfA").id,
      ),
    ).toMatchObject({ status: "ja", position: null });
    expect(
      liste.leitende.find((l: Json) => l.id === konto("leitendeJfA").id),
    ).toMatchObject({ status: "warteliste", position: 1 });
  });

  test("keine Absage und keine Zusage ausserhalb der Warteliste löst einen Push aus", async () => {
    const id = await termin(3);
    await registriereToken("leitendeJfA");
    await antwort("kommandoJfA", id, "ja");
    await antwort("kommandoJfA", id, "nein");
    expect(fcmAttrappe.nachrichten).toEqual([]);
  });

  test("zwei und mehr gleichzeitige Zusagen um den letzten Platz: genau eine bekommt ihn", async () => {
    const id = await termin(1);
    const ergebnisse = await Promise.all(
      LEITENDE.map(async (p) => json(await leitung(p, id, "ja"))),
    );
    expect(ergebnisse.filter((e) => e.status === "ja")).toHaveLength(1);
    const wartende = ergebnisse.filter((e) => e.status === "warteliste");
    expect(wartende.map((e) => e.position).sort()).toEqual([1, 2, 3, 4]);
    const zeilen = await db
      .select({ status: schema.leitungAnmeldung.status })
      .from(schema.leitungAnmeldung)
      .where(eq(schema.leitungAnmeldung.programmId, id));
    expect(zeilen.filter((z) => z.status === "ja")).toHaveLength(1);
  });

  test("gleichzeitige Absage und Zusage verlieren keinen Platz und vergeben keinen doppelt", async () => {
    const id = await termin(2);
    await antwort("kommandoJfA", id, "ja");
    await antwort("stellvertretung1JfA", id, "ja");
    await Promise.all([
      leitung("kommandoJfA", id, "nein"),
      leitung("stellvertretung1JfA", id, "nein"),
      leitung("stellvertretung2JfA", id, "ja"),
      leitung("leitendeJfA", id, "ja"),
      leitung("leitendeJfAElternKfA", id, "ja"),
    ]);
    const zeilen = await db
      .select({
        status: schema.leitungAnmeldung.status,
        seit: schema.leitungAnmeldung.wartelisteSeit,
      })
      .from(schema.leitungAnmeldung)
      .where(eq(schema.leitungAnmeldung.programmId, id));
    expect(zeilen.filter((z) => z.status === "ja")).toHaveLength(2);
    expect(zeilen.filter((z) => z.status === "warteliste")).toHaveLength(1);
  });

  test("ohne Höchstzahl: 200 mit Status, nie Warteliste, auch bei Terminen aus Lodur", async () => {
    const id = await termin(null);
    for (const p of LEITENDE) {
      expect(await antwort(p, id, "ja")).toEqual({
        status: "ja",
        position: null,
      });
    }
    expect(await antwort("kommandoJfA", id, "nein")).toEqual({
      status: "nein",
      position: null,
    });
    const lodur = (await legeProgrammAn(db, { einheitId: welt.einheit.jfA }))
      .id;
    expect(await antwort("kommandoJfA", lodur, "ja")).toEqual({
      status: "ja",
      position: null,
    });
  });

  test("begonnene Termine, Eltern und das Kantonsadmin-Konto: die bisherigen Fehler", async () => {
    const id = await termin(1);
    expect((await leitung("elternJfA", id, "ja")).status).toBe(403);
    expect((await leitung("kantonsadmin", id, "ja")).status).toBe(403);
    const begonnen = await legeProgrammAn(db, {
      einheitId: welt.einheit.jfA,
      beginn: new Date("2020-01-01T10:00:00Z"),
    });
    const res = await leitung("kommandoJfA", begonnen.id, "ja");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "PROGRAMM_BEGONNEN" });
    expect(
      (
        await aufruf("kommandoJfA", "PUT", `/api/v1/programme/${id}/leitung`, {
          status: "vielleicht",
        })
      ).status,
    ).toBe(400);
  });
});

describe("Sichtbarkeit von leitungPlaetze", () => {
  let id: string;
  beforeAll(async () => {
    id = await termin(2);
    await antwort("kommandoJfA", id, "ja");
    await antwort("stellvertretung1JfA", id, "ja");
    await antwort("stellvertretung2JfA", id, "ja");
    await antwort("leitendeJfA", id, "ja");
  });

  test("Kommando und Leitung sehen Plätze, Wartende und die eigene Position, in Liste und Detail", async () => {
    const erwartet = (eigenePosition: number | null) => ({
      hoechstzahl: 2,
      belegt: 2,
      frei: 0,
      voll: true,
      wartende: 2,
      eigenePosition,
    });
    for (const [p, position, anmeldung] of [
      ["kommandoJfA", null, "ja"],
      ["stellvertretung2JfA", 1, "warteliste"],
      ["leitendeJfA", 2, "warteliste"],
      ["leitendeJfAElternKfA", null, "offen"],
    ] as const) {
      const d = await detail(p, id);
      expect(d.leitungPlaetze).toEqual(erwartet(position));
      expect(d.eigeneAnmeldung).toBe(anmeldung);
      // Die Widget-Abfrage nutzt die Liste: Sie trägt dieselben Werte
      const liste = await json(
        await aufruf(
          p,
          "GET",
          "/api/v1/programme?von=2027-03-01&bis=2027-03-31",
        ),
      );
      const zeile = liste.programme.find((x: Json) => x.id === id);
      expect(zeile.leitungPlaetze).toEqual(erwartet(position));
      expect(zeile.eigeneAnmeldung).toBe(anmeldung);
    }
  });

  test("Eltern und das Kantonsadmin-Konto bekommen den Schlüssel nicht; Termine ohne Höchstzahl auch nicht", async () => {
    for (const p of ["elternJfA", "kantonsadmin"] as const) {
      const d = await detail(p, id);
      expect(d).not.toHaveProperty("leitungPlaetze");
      expect(JSON.stringify(d)).not.toMatch(/warteliste|wartende/);
      const liste = await json(
        await aufruf(
          p,
          "GET",
          "/api/v1/programme?von=2027-03-01&bis=2027-03-31",
        ),
      );
      const zeile = liste.programme.find((x: Json) => x.id === id);
      expect(zeile).not.toHaveProperty("leitungPlaetze");
    }
    const ohne = await termin(null);
    expect(await detail("kommandoJfA", ohne)).not.toHaveProperty(
      "leitungPlaetze",
    );
    expect(await teilnahmen("kommandoJfA", ohne)).not.toHaveProperty(
      "leitungPlaetze",
    );
  });

  test("Teilnahmen: Kommando und Leitung sehen Zusagen und Wartende mit Position, Eltern keine Leitenden", async () => {
    const d = await teilnahmen("kommandoJfA", id);
    expect(d.leitungPlaetze).toEqual({
      hoechstzahl: 2,
      belegt: 2,
      frei: 0,
      voll: true,
      wartende: 2,
      eigenePosition: null,
    });
    expect(d.zahlen.leitende).toMatchObject({ ja: 2, warteliste: 2 });
    const nach = (p: Persona) =>
      d.leitende.find((l: Json) => l.id === konto(p).id);
    expect(nach("kommandoJfA")).toMatchObject({ status: "ja", position: null });
    expect(nach("stellvertretung2JfA")).toMatchObject({
      status: "warteliste",
      position: 1,
    });
    expect(nach("leitendeJfA")).toMatchObject({
      status: "warteliste",
      position: 2,
    });
    // Name und Bild-Adresse stehen bei jeder Person, auch bei Zusagen
    expect(nach("kommandoJfA")).toHaveProperty("name");
    expect(nach("kommandoJfA")).toHaveProperty("bildUrl");

    const eltern = await teilnahmen("elternJfA", id);
    expect(eltern.leitende).toEqual([]);
    expect(eltern).not.toHaveProperty("leitungPlaetze");
    expect(eltern.zahlen.leitende).not.toHaveProperty("warteliste");
    expect(JSON.stringify(eltern)).not.toContain(konto("kommandoJfA").id);

    const leitende = await teilnahmen("leitendeJfA", id);
    expect(leitende.leitungPlaetze.eigenePosition).toBe(2);
  });

  test("Zusagen tragen die Bild-Adresse; die Bild-Route liefert das Bild anderen Leitenden der Einheit, Eltern nicht", async () => {
    const id = await termin(3);
    await antwort("leitendeJfA", id, "ja");
    // Ein Bild mit PNG-Kopf: Die Route liefert die gespeicherten Bytes
    await db
      .insert(schema.profilbild)
      .values({
        userId: konto("leitendeJfA").id!,
        inhalt: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      })
      .onConflictDoNothing();
    const d = await teilnahmen("kommandoJfA", id);
    const zusage = d.leitende.find(
      (l: Json) => l.id === konto("leitendeJfA").id,
    );
    expect(zusage.status).toBe("ja");
    expect(zusage.bildUrl).toContain(`/api/v1/personen/${zusage.id}/bild?v=`);
    const bild = (p: Persona) => aufruf(p, "GET", zusage.bildUrl as string);
    expect((await bild("leitendeJfA")).status).toBe(200);
    expect((await bild("kommandoJfA")).status).toBe(200);
    expect((await bild("elternJfA")).status).toBe(404);
  });
});

describe("Verwaltung: Höchstzahl setzen, senken, erhöhen", () => {
  const basis = () => `/api/v1/admin/einheiten/${welt.einheit.jfA}/termine`;

  test("Anlegen mit Höchstzahl; Werte ausserhalb 1 bis 500 und fremde Typen: 400", async () => {
    const body = {
      titel: "Übung",
      ganztaegig: false,
      beginn: "2031-06-10T18:30",
      ende: "2031-06-10T20:30",
    };
    const res = await aufruf("kommandoJfA", "POST", basis(), {
      ...body,
      leitungHoechstzahl: 4,
    });
    expect(res.status).toBe(201);
    const neu = await json(res);
    expect(neu.leitungHoechstzahl).toBe(4);
    for (const falsch of [0, -1, 501, 1.5, "4"]) {
      expect(
        (
          await aufruf("kommandoJfA", "POST", basis(), {
            ...body,
            leitungHoechstzahl: falsch,
          })
        ).status,
      ).toBe(400);
    }
    // Ohne Angabe gibt es keine Grenze
    const ohne = await json(await aufruf("kommandoJfA", "POST", basis(), body));
    expect(ohne.leitungHoechstzahl).toBeNull();
  });

  test("die Liste zeigt Plätze und Wartende je Termin", async () => {
    const id = await termin(1, "Plätze");
    await antwort("kommandoJfA", id, "ja");
    await antwort("stellvertretung1JfA", id, "ja");
    const res = await aufruf(
      "kommandoJfA",
      "GET",
      `${basis()}?von=2027-03-01&bis=2027-03-31`,
    );
    expect(res.status).toBe(200);
    const { termine } = await json(res);
    const t = termine.find((x: Json) => x.id === id);
    expect(t.leitungPlaetze).toEqual({
      hoechstzahl: 1,
      belegt: 1,
      frei: 0,
      voll: true,
      wartende: 1,
    });
    const lodur = termine.find((x: Json) => x.quelle === "lodur");
    expect(lodur?.leitungPlaetze ?? null).toBeNull();
  });

  test("unter die Zahl der Zusagen lässt sich die Höchstzahl nicht senken (409), auf sie schon", async () => {
    const id = await termin(3);
    for (const p of LEITENDE.slice(0, 3)) await antwort(p, id, "ja");
    const res = await adminAendern(id, { leitungHoechstzahl: 2 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "HOECHSTZAHL_ZU_KLEIN" });
    const [zeile] = await db
      .select({ h: schema.programm.leitungHoechstzahl })
      .from(schema.programm)
      .where(eq(schema.programm.id, id));
    expect(zeile!.h).toBe(3);
    expect((await adminAendern(id, { leitungHoechstzahl: 3 })).status).toBe(
      200,
    );
  });

  test("Erhöhen lässt Wartende der Reihe nach nachrücken, mit Push je Person; Aufheben der Grenze alle", async () => {
    const id = await termin(1);
    const t = {
      s1: await registriereToken("stellvertretung1JfA"),
      s2: await registriereToken("stellvertretung2JfA"),
      l: await registriereToken("leitendeJfA"),
      l2: await registriereToken("leitendeJfAElternKfA"),
    };
    await antwort("kommandoJfA", id, "ja");
    await antwort("stellvertretung1JfA", id, "ja");
    await antwort("stellvertretung2JfA", id, "ja");
    await antwort("leitendeJfA", id, "ja");
    await antwort("leitendeJfAElternKfA", id, "ja");
    fcmAttrappe.zuruecksetzen();

    expect((await adminAendern(id, { leitungHoechstzahl: 3 })).status).toBe(
      200,
    );
    const beteiligte = () => fcmAttrappe.nachrichten.map((n) => n.token).sort();
    expect(beteiligte()).toEqual([t.s1, t.s2].sort());
    expect(
      fcmAttrappe.nachrichten.every(
        (n) => n.notification?.title === "Du bist nachgerückt",
      ),
    ).toBe(true);
    const d = await teilnahmen("kommandoJfA", id);
    expect(d.leitungPlaetze).toMatchObject({
      belegt: 3,
      wartende: 2,
      voll: true,
    });
    expect(
      d.leitende.find((l: Json) => l.id === konto("leitendeJfA").id),
    ).toMatchObject({ status: "warteliste", position: 1 });

    fcmAttrappe.zuruecksetzen();
    expect((await adminAendern(id, { leitungHoechstzahl: null })).status).toBe(
      200,
    );
    expect(beteiligte()).toEqual([t.l, t.l2].sort());
    const frei = await detail("kommandoJfA", id);
    expect(frei).not.toHaveProperty("leitungPlaetze");
    expect(frei.eigeneAnmeldung).toBe("ja");
  });

  test("Termine aus Lodur haben keine Höchstzahl: 409, unverändert; die Datenbank lässt es auch nicht zu", async () => {
    const lodur = (await legeProgrammAn(db, { einheitId: welt.einheit.jfA }))
      .id;
    const res = await adminAendern(lodur, { leitungHoechstzahl: 2 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "TERMIN_AUS_LODUR" });
    await expect(
      db
        .update(schema.programm)
        .set({ leitungHoechstzahl: 2 })
        .where(eq(schema.programm.id, lodur)),
    ).rejects.toThrow();
  });

  test("Löschen des Termins nimmt die Warteliste mit", async () => {
    const id = await termin(1);
    await antwort("kommandoJfA", id, "ja");
    await antwort("stellvertretung1JfA", id, "ja");
    const res = await aufruf(
      "kommandoJfA",
      "DELETE",
      `${basis()}/${id}`.replace("/termine/", "/termine/"),
    );
    expect(res.status).toBe(204);
    const zeilen = await db
      .select()
      .from(schema.leitungAnmeldung)
      .where(eq(schema.leitungAnmeldung.programmId, id));
    expect(zeilen).toEqual([]);
  });

  test("Termin ansehen: Zusagen, Warteliste und Plätze für die Verwaltung", async () => {
    const id = await termin(1);
    await antwort("kommandoJfA", id, "ja");
    await antwort("stellvertretung1JfA", id, "ja");
    const d = await json(
      await aufruf(
        "kommandoJfA",
        "GET",
        `/api/v1/admin/auswertung/termine/${id}`,
      ),
    );
    expect(d.leitungPlaetze).toMatchObject({ belegt: 1, wartende: 1 });
    expect(d.zahlen.leitende).toMatchObject({ ja: 1, warteliste: 1 });
    expect(
      d.leitende.find((l: Json) => l.id === konto("stellvertretung1JfA").id),
    ).toMatchObject({ status: "warteliste", position: 1 });
  });
});

describe("Termin vorbei", () => {
  test("die Warteliste verfällt: keine Wartenden, die eigene Anmeldung zählt wieder als offen", async () => {
    const id = await termin(1);
    await antwort("kommandoJfA", id, "ja");
    await antwort("stellvertretung1JfA", id, "ja");
    await db
      .update(schema.programm)
      .set({
        beginn: new Date("2020-01-01T10:00:00Z"),
        ende: new Date("2020-01-01T12:00:00Z"),
      })
      .where(eq(schema.programm.id, id));
    const d = await detail("stellvertretung1JfA", id);
    expect(d.eigeneAnmeldung).toBe("offen");
    expect(d.leitungPlaetze).toMatchObject({ belegt: 1, wartende: 0 });
    expect(d.leitungPlaetze.eigenePosition).toBeNull();
    const t = await teilnahmen("kommandoJfA", id);
    expect(t.leitungPlaetze.wartende).toBe(0);
    expect(
      t.leitende.find((l: Json) => l.id === konto("stellvertretung1JfA").id),
    ).toMatchObject({ status: "offen", position: null });
  });
});
