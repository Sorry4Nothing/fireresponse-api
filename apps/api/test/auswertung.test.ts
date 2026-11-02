import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

let welt: Welt;
let konto: Record<string, PersonaKonto>;
const ROLLEN: Persona[] = [
  "kantonsadmin",
  "kommandoJfA",
  "stellvertretung1JfA",
  "kommandoKfA",
  "kommandoJfB",
  "leitendeJfA",
  "elternJfA",
];

const BASIS = "/api/v1/admin/auswertung";
const JAHR = "von=2025-01-01&bis=2025-12-31";

// Die Tests prüfen einzelne Felder; die Form steht in der OpenAPI-Beschreibung
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function hole(persona: string, pfad: string) {
  const antwort = await app.request(`${BASIS}${pfad}`, {
    headers: konto[persona].headers,
  });
  return {
    status: antwort.status,
    text: await antwort.clone().text(),
    json: (await antwort.json()) as Json,
  };
}

// Programme von JF A: ID je Name
const termin: Record<string, string> = {};
let kommandoId: string;
let stvId: string;
let leitungId: string;
let inaktivId: string;

async function antwort(
  programmId: string,
  teilnehmendeId: string,
  status: "ja" | "nein",
  von?: string,
) {
  await db.insert(schema.teilnahme).values({
    programmId,
    teilnehmendeId,
    status,
    geaendertVon: von,
  });
}

beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  konto = {};
  for (const p of ROLLEN) konto[p] = await legePersonaAn(welt, p);
  kommandoId = konto.kommandoJfA.id!;
  stvId = konto.stellvertretung1JfA.id!;
  leitungId = konto.leitendeJfA.id!;

  const a = welt.einheit.jfA;
  // Alle Daten liegen in der Vergangenheit (2025), ausser T4
  termin.t1 = (
    await legeProgrammAn(db, {
      einheitId: a,
      titel: "T1",
      beginn: new Date("2025-03-04T18:00:00Z"),
    })
  ).id;
  termin.t2 = (
    await legeProgrammAn(db, {
      einheitId: a,
      titel: "T2",
      beginn: new Date("2025-03-18T18:00:00Z"),
    })
  ).id;
  // Abgesagt: zählt nicht in die Quote
  termin.abgesagt = (
    await legeProgrammAn(db, {
      einheitId: a,
      titel: "Abgesagt",
      beginn: new Date("2025-03-20T18:00:00Z"),
    })
  ).id;
  await db
    .update(schema.programm)
    .set({ status: "abgesagt" })
    .where(eq(schema.programm.id, termin.abgesagt));
  // Noch nicht begonnen: zählt als «kommend», nicht in die Quote
  termin.kommend = (
    await legeProgrammAn(db, {
      einheitId: a,
      titel: "Kommend",
      beginn: new Date("2099-01-10T18:00:00Z"),
    })
  ).id;
  // Rand des Jahres in Schweizer Zeit: 22:30 UTC am 31.12.2024 ist noch 2024, 23:30 UTC schon der 1.1.2025
  termin.silvester2024 = (
    await legeProgrammAn(db, {
      einheitId: a,
      titel: "Silvester 2024 (draussen)",
      beginn: new Date("2024-12-31T22:30:00Z"),
    })
  ).id;
  termin.neujahr2025 = (
    await legeProgrammAn(db, {
      einheitId: a,
      titel: "Neujahr 2025 (drin)",
      beginn: new Date("2024-12-31T23:30:00Z"),
    })
  ).id;
  termin.silvester2025 = (
    await legeProgrammAn(db, {
      einheitId: a,
      titel: "Silvester 2025 (drin)",
      beginn: new Date("2025-12-31T22:30:00Z"),
    })
  ).id;
  termin.neujahr2026 = (
    await legeProgrammAn(db, {
      einheitId: a,
      titel: "Neujahr 2026 (draussen)",
      beginn: new Date("2025-12-31T23:30:00Z"),
    })
  ).id;
  // Ein Lager über drei Tage zählt einmal, am ersten Tag
  termin.lager = (
    await legeProgrammAn(db, {
      einheitId: a,
      titel: "Lager",
      tagVon: "2025-06-30",
      tagBis: "2025-07-02",
    })
  ).id;
  // KF A hat ein eigenes Programm: Es darf in JF A nie auftauchen
  termin.kfA = (
    await legeProgrammAn(db, {
      einheitId: welt.einheit.kfA,
      titel: "KF A",
      beginn: new Date("2025-03-05T18:00:00Z"),
    })
  ).id;

  // Ohne Anmeldung (Art nicht freigegeben): Alle wären «offen»; der Termin zählt nicht in die Quote
  await legeProgrammAn(db, {
    einheitId: a,
    titel: "Sitzung ohne Anmeldung",
    beginn: new Date("2025-03-25T18:00:00Z"),
    art: "Sitzung",
    anmeldbar: false,
  });

  const tn = welt.teilnehmende;
  // T1: Person ja, Person2 nein, Wechsel offen
  await antwort(termin.t1, tn.jfA, "ja", konto.elternJfA.id!);
  await antwort(termin.t1, tn.jfA2, "nein");
  // T2: beide ja; auf den abgesagten und den kommenden Termin gab es auch Antworten
  await antwort(termin.t2, tn.jfA, "ja");
  await antwort(termin.t2, tn.jfA2, "ja");
  await antwort(termin.abgesagt, tn.jfA, "ja");
  await antwort(termin.kommend, tn.jfA, "ja");
  await antwort(termin.lager, tn.jfA, "nein");
  await antwort(termin.neujahr2025, tn.jfA, "ja");
  await antwort(termin.silvester2024, tn.jfA, "ja");
  await antwort(termin.neujahr2026, tn.jfA, "ja");
  await antwort(termin.kfA, tn.kfA, "ja");

  // Leitende: Kommando ja/ja, Stellvertretung nein auf T1
  const leitung = (programmId: string, userId: string, status: "ja" | "nein") =>
    db.insert(schema.leitungAnmeldung).values({ programmId, userId, status });
  await leitung(termin.t1, kommandoId, "ja");
  await leitung(termin.t2, kommandoId, "ja");
  await leitung(termin.t1, stvId, "nein");

  // Eine inaktive Person mit Antworten: fehlt überall
  [{ id: inaktivId }] = await db
    .insert(schema.teilnehmende)
    .values({
      einheitId: a,
      vorname: "Inaktiv",
      nachname: "Person",
      inaktivSeit: new Date("2025-02-01T00:00:00Z"),
    })
    .returning({ id: schema.teilnehmende.id });
  await antwort(termin.t1, inaktivId, "ja");
});

describe("Zugriff und Mandantentrennung", () => {
  const ROUTEN = [
    `/filter`,
    `/termine?${JAHR}`,
    `/quoten?${JAHR}`,
    `/jahr?jahr=2025`,
  ];

  test.each(ROUTEN)("%s: Leitende und Eltern bekommen 403", async (pfad) => {
    expect((await hole("leitendeJfA", pfad)).status).toBe(403);
    expect((await hole("elternJfA", pfad)).status).toBe(403);
  });

  test("Kommando sieht nur die eigene Einheit, das Kantonsadmin-Konto alle", async () => {
    const eigene = await hole("kommandoJfA", `/quoten?${JAHR}`);
    expect(eigene.status).toBe(200);
    expect(
      new Set(eigene.json.personen.map((p: Json) => p.einheit.id)),
    ).toEqual(new Set([welt.einheit.jfA]));
    const alle = await hole("kantonsadmin", `/quoten?${JAHR}`);
    const einheiten = new Set(
      alle.json.personen.map((p: Json) => p.einheit.id),
    );
    expect(einheiten).toContain(welt.einheit.jfA);
    expect(einheiten).toContain(welt.einheit.kfA);
  });

  test("Stellvertretung hat dieselbe Sicht wie das Kommando", async () => {
    const a = await hole("kommandoJfA", `/quoten?${JAHR}`);
    const b = await hole("stellvertretung1JfA", `/quoten?${JAHR}`);
    expect(b.json).toEqual(a.json);
  });

  test("Fremde Einheit im Filter: 404, nie leer und nie ein Treffer", async () => {
    for (const persona of ["kommandoKfA", "kommandoJfB"]) {
      for (const route of ["quoten", "termine"]) {
        const r = await hole(
          persona,
          `/${route}?${JAHR}&einheitId=${welt.einheit.jfA}`,
        );
        expect(r.status, `${persona} ${route}`).toBe(404);
      }
      const jahr = await hole(
        persona,
        `/jahr?jahr=2025&einheitId=${welt.einheit.jfA}`,
      );
      expect(jahr.status).toBe(404);
    }
    // Unbekannte Einheit ist von einer fremden nicht zu unterscheiden
    const unbekannt = await hole(
      "kommandoJfA",
      `/quoten?${JAHR}&einheitId=${randomUUID()}`,
    );
    expect(unbekannt.status).toBe(404);
  });

  test("Fremder Bezirk im Filter liefert eine leere Auswertung statt fremder Daten", async () => {
    const r = await hole(
      "kommandoJfA",
      `/quoten?${JAHR}&bezirkId=${welt.bezirkBId}`,
    );
    expect(r.status).toBe(200);
    expect(r.json.personen).toEqual([]);
    const t = await hole(
      "kommandoJfA",
      `/termine?${JAHR}&bezirkId=${welt.bezirkBId}`,
    );
    expect(t.json.termine).toEqual([]);
  });

  test("Filter listet nur die verwaltbaren Einheiten; der Umschalter gilt nur für das Kantonsadmin-Konto", async () => {
    const k = await hole("kommandoJfA", `/filter`);
    expect(k.json.umschalter).toBe(false);
    expect(k.json.einheiten.map((e: Json) => e.id)).toEqual([welt.einheit.jfA]);
    expect(k.json.bezirke).toEqual([
      { id: welt.bezirkAId, name: expect.any(String) },
    ]);
    const admin = await hole("kantonsadmin", `/filter`);
    expect(admin.json.umschalter).toBe(true);
    const ids = admin.json.einheiten.map((e: Json) => e.id);
    expect(ids).toEqual(expect.arrayContaining(Object.values(welt.einheit)));
  });
});

describe("Eingabe", () => {
  test.each([
    ["Zeitraum verkehrt", `/quoten?von=2025-02-01&bis=2025-01-01`],
    ["länger als ein Jahr", `/quoten?von=2025-01-01&bis=2026-06-01`],
    ["ohne Zeitraum", `/quoten`],
    ["Datum ungültig", `/termine?von=2025-13-01&bis=2025-14-01`],
    ["Jahr 0000", `/termine?von=0000-01-01&bis=0000-02-01`],
    ["unbekannter Parameter", `/quoten?${JAHR}&alle=1`],
    ["Rolle unbekannt", `/quoten?${JAHR}&rolle=eltern`],
    ["Einheit keine UUID", `/quoten?${JAHR}&einheitId=abc`],
    ["Jahr fehlt", `/jahr`],
    ["Jahr ausserhalb", `/jahr?jahr=1999`],
  ])("400: %s", async (_, pfad) => {
    expect((await hole("kommandoJfA", pfad)).status).toBe(400);
  });

  test("ein ganzes Schaltjahr ist erlaubt", async () => {
    expect(
      (await hole("kommandoJfA", `/quoten?von=2024-01-01&bis=2024-12-31`))
        .status,
    ).toBe(200);
  });
});

describe("Quote pro Person", () => {
  let zeilen: Json[];
  beforeAll(async () => {
    zeilen = (await hole("kommandoJfA", `/quoten?${JAHR}`)).json.personen;
  });
  const person = (id: string) => zeilen.find((p) => p.id === id);

  test("zählt aktive, begonnene Termine im Schweizer Jahr; abgesagte, kommende und Termine ausserhalb fallen weg", () => {
    // T1 ja, T2 ja, Lager nein, Neujahr 2025 ja; Silvester 2025 ohne Antwort = offen. Nicht: abgesagt, kommend, Silvester 2024, Neujahr 2026
    expect(person(welt.teilnehmende.jfA)).toMatchObject({
      art: "teilnehmende",
      termine: 5,
      ja: 3,
      nein: 1,
      offen: 1,
      quote: 0.6,
    });
    // jfA2: T1 nein, T2 ja, sonst offen
    expect(person(welt.teilnehmende.jfA2)).toMatchObject({
      termine: 5,
      ja: 1,
      nein: 1,
      offen: 3,
      quote: 0.2,
    });
  });

  test("inaktive Personen fehlen", () => {
    expect(person(inaktivId)).toBeUndefined();
  });

  test("Leitende getrennt, mit Rolle", () => {
    expect(person(kommandoId)).toMatchObject({
      art: "leitende",
      rolle: "kommandant",
      termine: 5,
      ja: 2,
      nein: 0,
      offen: 3,
    });
    expect(person(stvId)).toMatchObject({
      rolle: "stellvertretung",
      ja: 0,
      nein: 1,
      quote: 0,
    });
  });

  test("Rolle-Filter trennt Teilnehmende und Leitende", async () => {
    const tn = (await hole("kommandoJfA", `/quoten?${JAHR}&rolle=teilnehmende`))
      .json.personen;
    expect(tn.length).toBeGreaterThan(0);
    expect(tn.every((p: Json) => p.art === "teilnehmende")).toBe(true);
    const le = (await hole("kommandoJfA", `/quoten?${JAHR}&rolle=leitende`))
      .json.personen;
    expect(le.every((p: Json) => p.art === "leitende")).toBe(true);
    expect(le.map((p: Json) => p.id)).toContain(leitungId);
  });

  test("Zeitraum: ein Monat enthält nur dessen Termine", async () => {
    const r = await hole(
      "kommandoJfA",
      `/quoten?von=2025-03-01&bis=2025-03-31&rolle=teilnehmende`,
    );
    const p = r.json.personen.find((x: Json) => x.id === welt.teilnehmende.jfA);
    expect(p).toMatchObject({ termine: 2, ja: 2, quote: 1 });
  });

  test("Ohne Termine im Zeitraum bleibt die Person ausser Betracht", async () => {
    const r = await hole(
      "kommandoJfA",
      `/quoten?von=2020-01-01&bis=2020-12-31`,
    );
    expect(r.json.personen).toEqual([]);
  });

  test("Wechsel von den Eltern aufs Kind: die Zahlen bleiben bei der Person", async () => {
    // Die Eltern hatten für jfA auf T1 geantwortet; das Kind übernimmt das Konto
    const kind = await legePersonaAn(welt, "teilnehmendeSelbstJfA");
    expect(kind.id).toBeTruthy();
    const vorher = person(welt.teilnehmende.jfA);
    await db
      .delete(schema.teilnehmendeKonto)
      .where(
        and(
          eq(schema.teilnehmendeKonto.userId, konto.elternJfA.id!),
          eq(schema.teilnehmendeKonto.teilnehmendeId, welt.teilnehmende.jfA),
        ),
      );
    await db.insert(schema.teilnehmendeKonto).values({
      userId: kind.id!,
      teilnehmendeId: welt.teilnehmende.jfA,
      art: "selbst",
    });
    const nachher = (
      await hole("kommandoJfA", `/quoten?${JAHR}&rolle=teilnehmende`)
    ).json.personen.find((p: Json) => p.id === welt.teilnehmende.jfA);
    expect(nachher).toEqual(vorher);
    // Für die übrigen Tests wieder die Eltern
    await db
      .delete(schema.teilnehmendeKonto)
      .where(eq(schema.teilnehmendeKonto.userId, kind.id!));
    await db.insert(schema.teilnehmendeKonto).values({
      userId: konto.elternJfA.id!,
      teilnehmendeId: welt.teilnehmende.jfA,
      art: "eltern",
    });
  });

  test("deaktivierte Leitende fehlen", async () => {
    const [extra] = await db
      .insert(schema.user)
      .values({
        name: "Deaktivierte Leitung",
        email: `${randomUUID()}@example.org`,
        username: `deakt.${randomUUID().slice(0, 8)}`,
        mussPasswortAendern: false,
        deaktiviertAm: new Date(),
        banned: true,
      })
      .returning({ id: schema.user.id });
    await db.insert(schema.einheitRolle).values({
      userId: extra.id,
      einheitId: welt.einheit.jfA,
      typ: "leitung",
    });
    const r = await hole("kommandoJfA", `/quoten?${JAHR}&rolle=leitende`);
    expect(r.json.personen.map((p: Json) => p.id)).not.toContain(extra.id);
  });
});

describe("Datenminimierung", () => {
  test("Antworten enthalten weder Konten noch Kontaktdaten oder Google-Felder", async () => {
    const ziele = [
      `/quoten?${JAHR}`,
      `/termine?${JAHR}`,
      `/termine/${termin.t1}`,
      `/jahr?jahr=2025`,
      `/einheiten/${welt.einheit.jfA}/teilnehmende/${welt.teilnehmende.jfA}?${JAHR}`,
      `/einheiten/${welt.einheit.jfA}/leitende/${kommandoId}?${JAHR}`,
    ];
    for (const pfad of ziele) {
      const r = await hole("kantonsadmin", pfad);
      expect(r.status, pfad).toBe(200);
      for (const verboten of [
        "email",
        "username",
        "telefon",
        "passwort",
        "geaendertVon",
        "googleOrt",
        "googleBeschreibung",
        "marke-",
        "bildUrl",
        "Thema",
        "Aufgebot",
        konto.elternJfA.id!,
      ]) {
        expect(r.text, `${pfad}: ${verboten}`).not.toContain(verboten);
      }
    }
  });

  test("Personenzeilen haben genau die dokumentierten Felder", async () => {
    const r = await hole("kommandoJfA", `/quoten?${JAHR}`);
    for (const p of r.json.personen) {
      expect(Object.keys(p).sort()).toEqual(
        [
          "art",
          "einheit",
          "id",
          "ja",
          "name",
          "nein",
          "offen",
          "quote",
          "rolle",
          "termine",
        ].sort(),
      );
    }
  });
});

describe("Termine und Präsenzliste", () => {
  test("Terminliste mit Zahlen; abgesagte und kommende sind erkennbar", async () => {
    const r = await hole("kommandoJfA", `/termine?${JAHR}`);
    expect(r.status).toBe(200);
    const titel = r.json.termine.map((t: Json) => t.titel);
    expect(titel).not.toContain("KF A");
    expect(titel).not.toContain("Silvester 2024 (draussen)");
    expect(titel).not.toContain("Neujahr 2026 (draussen)");
    expect(titel).toContain("Abgesagt");
    const t1 = r.json.termine.find((t: Json) => t.id === termin.t1);
    // Aktive Teilnehmende von JF A: jfA, jfA2, jfAWechsel (inaktiv zählt nicht)
    expect(t1.teilnehmende).toMatchObject({ ja: 1, nein: 1, offen: 1 });
    expect(t1.leitende).toMatchObject({ ja: 1, nein: 1 });
    expect(t1.begonnen).toBe(true);
    const kommend = r.json.termine.find((t: Json) => t.id === termin.kommend);
    // 2099 liegt ausserhalb: nur mit Zeitraum zu sehen
    expect(kommend).toBeUndefined();
    const abgesagt = r.json.termine.find((t: Json) => t.id === termin.abgesagt);
    expect(abgesagt.status).toBe("abgesagt");
  });

  test("Termine sind nach Beginn sortiert", async () => {
    const r = await hole("kommandoJfA", `/termine?${JAHR}`);
    const beginn = r.json.termine.map(
      (t: Json) => t.beginn ?? `${t.tagVon}T00:00:00Z`,
    );
    expect(beginn).toEqual([...beginn].sort());
  });

  test("Präsenzliste trennt Teilnehmende und Leitende und zählt ja, nein und offen", async () => {
    const r = await hole("kommandoJfA", `/termine/${termin.t1}`);
    expect(r.status).toBe(200);
    expect(r.json.termin).toMatchObject({ titel: "T1", begonnen: true });
    expect(r.json.zahlen.teilnehmende).toMatchObject({
      ja: 1,
      nein: 1,
      offen: 1,
    });
    const status = Object.fromEntries(
      r.json.teilnehmende.map((p: Json) => [p.id, p.status]),
    );
    expect(status).toEqual({
      [welt.teilnehmende.jfA]: "ja",
      [welt.teilnehmende.jfA2]: "nein",
      [welt.teilnehmende.jfAWechsel]: "offen",
    });
    expect(r.json.teilnehmende.map((p: Json) => p.id)).not.toContain(inaktivId);
    const leitende = Object.fromEntries(
      r.json.leitende.map((l: Json) => [l.id, [l.rolle, l.status]]),
    );
    expect(leitende[kommandoId]).toEqual(["kommandant", "ja"]);
    expect(leitende[stvId]).toEqual(["stellvertretung", "nein"]);
    expect(leitende[leitungId]).toEqual(["leitung", "offen"]);
  });

  test("Präsenzliste: fremde Einheit 404, Leitende und Eltern 403", async () => {
    for (const p of ["kommandoKfA", "kommandoJfB"]) {
      expect((await hole(p, `/termine/${termin.t1}`)).status, p).toBe(404);
    }
    for (const p of ["leitendeJfA", "elternJfA"]) {
      expect((await hole(p, `/termine/${termin.t1}`)).status, p).toBe(403);
    }
    expect((await hole("kommandoJfA", `/termine/${randomUUID()}`)).status).toBe(
      404,
    );
    expect((await hole("kommandoJfA", `/termine/kein-uuid`)).status).toBe(400);
  });
});

describe("Drilldown pro Person", () => {
  const teilnehmendePfad = (id: string, einheitId = welt.einheit.jfA) =>
    `/einheiten/${einheitId}/teilnehmende/${id}?${JAHR}`;

  test("Teilnehmende: Zahlen und Termine mit Antwort", async () => {
    const r = await hole(
      "kommandoJfA",
      teilnehmendePfad(welt.teilnehmende.jfA),
    );
    expect(r.status).toBe(200);
    expect(r.json.person).toMatchObject({
      id: welt.teilnehmende.jfA,
      art: "teilnehmende",
      einheit: { id: welt.einheit.jfA },
    });
    expect(r.json.zahlen).toMatchObject({
      termine: 5,
      ja: 3,
      nein: 1,
      offen: 1,
    });
    expect(r.json.termine).toHaveLength(5);
    const nachTitel = Object.fromEntries(
      r.json.termine.map((t: Json) => [t.titel, t.antwort]),
    );
    expect(nachTitel).toMatchObject({
      T1: "ja",
      T2: "ja",
      Lager: "nein",
      "Neujahr 2025 (drin)": "ja",
      "Silvester 2025 (drin)": "offen",
    });
    // Dieselbe Zahl wie in der Quote
    const q = (await hole("kommandoJfA", `/quoten?${JAHR}`)).json.personen.find(
      (p: Json) => p.id === welt.teilnehmende.jfA,
    );
    expect(r.json.zahlen.quote).toBe(q.quote);
  });

  test("Leitende: Zahlen und Termine", async () => {
    const r = await hole(
      "kommandoJfA",
      `/einheiten/${welt.einheit.jfA}/leitende/${stvId}?${JAHR}`,
    );
    expect(r.status).toBe(200);
    expect(r.json.person).toMatchObject({
      art: "leitende",
      rolle: "stellvertretung",
    });
    expect(r.json.zahlen).toMatchObject({
      termine: 5,
      ja: 0,
      nein: 1,
      offen: 4,
    });
  });

  test("Inaktive, fremde und unbekannte Personen: 404", async () => {
    expect(
      (await hole("kommandoJfA", teilnehmendePfad(inaktivId))).status,
    ).toBe(404);
    // Person aus KF A unter der Einheit JF A
    expect(
      (await hole("kommandoJfA", teilnehmendePfad(welt.teilnehmende.kfA)))
        .status,
    ).toBe(404);
    expect(
      (await hole("kommandoJfA", teilnehmendePfad(randomUUID()))).status,
    ).toBe(404);
    // Leitung einer anderen Einheit unter JF A
    const fremd = await hole(
      "kommandoJfA",
      `/einheiten/${welt.einheit.jfA}/leitende/${konto.kommandoKfA.id}?${JAHR}`,
    );
    expect(fremd.status).toBe(404);
  });

  test("Einheit fremd 404, ohne Recht 403", async () => {
    const pfad = teilnehmendePfad(welt.teilnehmende.jfA);
    expect((await hole("kommandoKfA", pfad)).status).toBe(404);
    expect((await hole("kommandoJfB", pfad)).status).toBe(404);
    expect((await hole("leitendeJfA", pfad)).status).toBe(403);
    expect((await hole("elternJfA", pfad)).status).toBe(403);
  });

  test("Zeitraum ist Pflicht und begrenzt", async () => {
    const id = welt.teilnehmende.jfA;
    const basis = `/einheiten/${welt.einheit.jfA}/teilnehmende/${id}`;
    expect((await hole("kommandoJfA", basis)).status).toBe(400);
    expect(
      (await hole("kommandoJfA", `${basis}?von=2020-01-01&bis=2025-01-01`))
        .status,
    ).toBe(400);
  });
});

describe("Jahresübersicht", () => {
  test("Summe und Monate je Einheit", async () => {
    const r = await hole("kommandoJfA", `/jahr?jahr=2025`);
    expect(r.status).toBe(200);
    expect(r.json.jahr).toBe(2025);
    expect(r.json.einheiten).toHaveLength(1);
    const e = r.json.einheiten[0];
    expect(e.einheit).toMatchObject({ id: welt.einheit.jfA, typ: "jf" });
    expect(e.einheit.bezirk.id).toBe(welt.bezirkAId);
    // Bezug: T1, T2, Lager, Neujahr 2025, Silvester 2025
    expect(e.termine).toBe(5);
    expect(e.kommend).toBe(0);
    // Je Person die Antworten des Jahres, summiert über alle aktiven Teilnehmenden (3 Personen × 5 Termine = 15)
    expect(e.teilnehmende.ja + e.teilnehmende.nein + e.teilnehmende.offen).toBe(
      15,
    );
    expect(e.teilnehmende).toMatchObject({ ja: 4, nein: 2, offen: 9 });
    expect(e.monate).toHaveLength(12);
    const maerz = e.monate[2];
    expect(maerz).toMatchObject({ monat: 3, termine: 2 });
    expect(maerz.teilnehmende).toMatchObject({ ja: 3, nein: 1, offen: 2 });
    expect(e.monate[0]).toMatchObject({ monat: 1, termine: 1 });
    expect(e.monate[5].termine).toBe(1);
    expect(e.monate[3].teilnehmende).toMatchObject({
      ja: 0,
      nein: 0,
      offen: 0,
      quote: null,
    });
    // Das Lager zählt im Juni, nicht im Juli
    expect(e.monate[5].termine).toBe(1);
    expect(e.monate[6].termine).toBe(0);
    expect(e.monate[11].termine).toBe(1);
  });

  test("das Kantonsadmin-Konto sieht jede Einheit, auch ohne Programme; Bezirk filtert", async () => {
    const r = await hole("kantonsadmin", `/jahr?jahr=2025`);
    const ids = r.json.einheiten.map((e: Json) => e.einheit.id);
    expect(ids).toEqual(expect.arrayContaining(Object.values(welt.einheit)));
    const b = await hole(
      "kantonsadmin",
      `/jahr?jahr=2025&bezirkId=${welt.bezirkBId}`,
    );
    expect(
      new Set(b.json.einheiten.map((e: Json) => e.einheit.bezirk.id)),
    ).toEqual(new Set([welt.bezirkBId]));
    const leer = b.json.einheiten[0];
    expect(leer.termine).toBe(0);
    expect(leer.teilnehmende.quote).toBeNull();
  });

  test("Rolle lässt die andere Gruppe weg", async () => {
    const e = (await hole("kommandoJfA", `/jahr?jahr=2025&rolle=leitende`)).json
      .einheiten[0];
    expect(e.teilnehmende).toBeNull();
    expect(e.leitende).not.toBeNull();
    expect(e.monate[2].teilnehmende).toBeNull();
    const t = (await hole("kommandoJfA", `/jahr?jahr=2025&rolle=teilnehmende`))
      .json.einheiten[0];
    expect(t.leitende).toBeNull();
  });

  test("Noch nicht begonnene Programme zählen als kommend, nicht in die Quote", async () => {
    const e = (await hole("kommandoJfA", `/jahr?jahr=2099`)).json.einheiten[0];
    expect(e.termine).toBe(0);
    expect(e.kommend).toBe(1);
    expect(e.teilnehmende.quote).toBeNull();
  });

  test("Jahr ohne Programme: Nullen und keine Quote", async () => {
    const e = (await hole("kommandoJfA", `/jahr?jahr=2031`)).json.einheiten[0];
    expect(e.termine).toBe(0);
    expect(e.teilnehmende).toEqual({ ja: 0, nein: 0, offen: 0, quote: null });
  });
});

describe("Ohne Sitzung", () => {
  test("401", async () => {
    const r = await app.request(`${BASIS}/filter`);
    expect(r.status).toBe(401);
  });
});
