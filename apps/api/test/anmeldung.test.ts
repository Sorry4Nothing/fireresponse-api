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
// Programme in der Zukunft (offen) je Einheit, dazu eines in der Vergangenheit
let jfA: string;
let kfA: string;
let jfB: string;
let vorbei: string;
// Im Anmeldefenster (42 Tage): Die Fenstergrenzen prüft test/termine.test.ts
const IN_ZEHN_TAGEN = () => new Date(Date.now() + 10 * 86_400_000);

beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  const anlegen = (einheitId: string, beginn = IN_ZEHN_TAGEN()) =>
    legeProgrammAn(db, { einheitId, beginn }).then((p) => p.id);
  jfA = await anlegen(welt.einheit.jfA);
  kfA = await anlegen(welt.einheit.kfA);
  jfB = await anlegen(welt.einheit.jfB);
  vorbei = await anlegen(welt.einheit.jfA, new Date("2020-01-01T10:00:00Z"));
});

const person = (persona: Persona) => legePersonaAn(welt, persona);

const senden = (
  konto: PersonaKonto,
  methode: "GET" | "PUT",
  pfad: string,
  body?: unknown,
) =>
  app.request(pfad, {
    method: methode,
    headers: { ...konto.headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const melde = (
  konto: PersonaKonto,
  programmId: string,
  teilnehmendeId: string,
  status: unknown = "ja",
) =>
  senden(
    konto,
    "PUT",
    `/api/v1/programme/${programmId}/teilnahmen/${teilnehmendeId}`,
    { status },
  );

const meldeLeitung = (konto: PersonaKonto, programmId: string, status = "ja") =>
  senden(konto, "PUT", `/api/v1/programme/${programmId}/leitung`, { status });

const lies = async (konto: PersonaKonto, pfad: string) =>
  (await senden(konto, "GET", pfad)).json();

describe("PUT /api/v1/programme/:id/teilnahmen/:teilnehmendeId", () => {
  test("Eltern melden ihre Person an und ändern die Antwort", async () => {
    const eltern = await person("elternJfA");
    expect((await melde(eltern, jfA, welt.teilnehmende.jfA)).status).toBe(204);
    let detail = await lies(eltern, `/api/v1/programme/${jfA}`);
    expect(detail.teilnehmende).toEqual([
      {
        id: welt.teilnehmende.jfA,
        vorname: "Person",
        status: "ja",
        abzeichen: null,
      },
    ]);

    expect(
      (await melde(eltern, jfA, welt.teilnehmende.jfA, "nein")).status,
    ).toBe(204);
    detail = await lies(eltern, `/api/v1/programme/${jfA}`);
    expect(detail.teilnehmende[0].status).toBe("nein");
    const zeilen = await db
      .select({ von: schema.teilnahme.geaendertVon })
      .from(schema.teilnahme)
      .where(
        and(
          eq(schema.teilnahme.programmId, jfA),
          eq(schema.teilnahme.teilnehmendeId, welt.teilnehmende.jfA),
        ),
      );
    expect(zeilen).toEqual([{ von: eltern.id }]);
  });

  test("Teilnehmende mit eigenem Konto antworten selbst", async () => {
    const selbst = await person("teilnehmendeSelbstJfA");
    expect(
      (await melde(selbst, jfA, welt.teilnehmende.jfAWechsel)).status,
    ).toBe(204);
  });

  test("Eltern mit Personen in zwei Bezirken antworten in jedem für die eigene Person", async () => {
    const eltern = await person("elternAundB");
    expect((await melde(eltern, jfA, welt.teilnehmende.jfA)).status).toBe(204);
    expect((await melde(eltern, jfB, welt.teilnehmende.jfB)).status).toBe(204);
    // Die Person des anderen Bezirks gehört nicht zu diesem Programm
    expect((await melde(eltern, jfB, welt.teilnehmende.jfA)).status).toBe(404);
    expect((await melde(eltern, jfA, welt.teilnehmende.jfB)).status).toBe(404);
  });

  test("Kommando, Leitende und Kantonsadmin antworten nicht für andere: 404", async () => {
    for (const persona of [
      "kommandoJfA",
      "stellvertretung1JfA",
      "leitendeJfA",
      "kantonsadmin",
    ] as const) {
      const konto = await person(persona);
      expect(
        (await melde(konto, jfA, welt.teilnehmende.jfA)).status,
        persona,
      ).toBe(404);
    }
  });

  test("fremde Personen derselben Einheit: 404, auch nach dem Wechsel aufs Kind-Konto", async () => {
    const [nachWechsel, eltern] = await Promise.all([
      person("elternNachWechsel"),
      person("elternJfA"),
    ]);
    expect((await melde(nachWechsel, jfA, welt.teilnehmende.jfA2)).status).toBe(
      204,
    );
    // Das Kind, das jetzt selbst antwortet, ist für die früheren Eltern unsichtbar
    expect(
      (await melde(nachWechsel, jfA, welt.teilnehmende.jfAWechsel)).status,
    ).toBe(404);
    expect((await melde(eltern, jfA, welt.teilnehmende.jfA2)).status).toBe(404);
  });

  test("Programme anderer Einheiten und unbekannte IDs: 404", async () => {
    const eltern = await person("elternJfA");
    expect((await melde(eltern, kfA, welt.teilnehmende.jfA)).status).toBe(404);
    expect((await melde(eltern, jfB, welt.teilnehmende.jfA)).status).toBe(404);
    expect(
      (
        await melde(
          eltern,
          "0198f0a0-0000-7000-8000-000000000000",
          welt.teilnehmende.jfA,
        )
      ).status,
    ).toBe(404);
  });

  test("Leitende Person und Eltern einer anderen Einheit: zuständig nur für KF A", async () => {
    const konto = await person("leitendeJfAElternKfA");
    expect((await melde(konto, kfA, welt.teilnehmende.kfA)).status).toBe(204);
    // In JF A ist sie Leitende, aber nicht verknüpft
    expect((await melde(konto, jfA, welt.teilnehmende.jfA)).status).toBe(404);
  });

  test("begonnene oder abgesagte Programme: 409", async () => {
    const eltern = await person("elternJfA");
    const antwort = await melde(eltern, vorbei, welt.teilnehmende.jfA);
    expect(antwort.status).toBe(409);
    expect(await antwort.json()).toMatchObject({
      code: "PROGRAMM_GESCHLOSSEN",
    });
    const [abgesagt] = await db
      .insert(schema.programm)
      .values({
        einheitId: welt.einheit.jfA,
        googleEventId: "abgesagt-1",
        art: "Übung",
        titel: "Abgesagt",
        ganztaegig: false,
        beginn: IN_ZEHN_TAGEN(),
        ende: IN_ZEHN_TAGEN(),
        status: "abgesagt",
      })
      .returning({ id: schema.programm.id });
    expect(
      (await melde(eltern, abgesagt.id, welt.teilnehmende.jfA)).status,
    ).toBe(409);
  });

  test("inaktive Person: 403", async () => {
    const eltern = await person("elternJfA");
    const [inaktiv] = await db
      .insert(schema.teilnehmende)
      .values({
        einheitId: welt.einheit.jfA,
        vorname: "Person",
        nachname: "Inaktiv",
        inaktivSeit: new Date(),
      })
      .returning({ id: schema.teilnehmende.id });
    await db.insert(schema.teilnehmendeKonto).values({
      userId: eltern.id!,
      teilnehmendeId: inaktiv.id,
      art: "eltern",
    });
    expect((await melde(eltern, jfA, inaktiv.id)).status).toBe(403);
  });

  test("ungültige Eingaben: 400", async () => {
    const eltern = await person("elternJfA");
    expect(
      (await melde(eltern, jfA, welt.teilnehmende.jfA, "vielleicht")).status,
    ).toBe(400);
    expect(
      (
        await senden(
          eltern,
          "PUT",
          `/api/v1/programme/${jfA}/teilnahmen/${welt.teilnehmende.jfA}`,
          { status: "ja", extra: 1 },
        )
      ).status,
    ).toBe(400);
    expect((await melde(eltern, jfA, "kein-uuid")).status).toBe(400);
  });
});

describe("GET /api/v1/programme/:id/teilnahmen", () => {
  test("Kommando sieht Zahlen, alle aktiven Personen der Einheit und die Rollen", async () => {
    const [kommando, stv, leitung, eltern] = await Promise.all([
      person("kommandoJfA"),
      person("stellvertretung1JfA"),
      person("leitendeJfA"),
      person("elternJfA"),
    ]);
    await melde(eltern, jfA, welt.teilnehmende.jfA, "ja");
    await meldeLeitung(leitung, jfA, "nein");

    const antwort = await senden(
      kommando,
      "GET",
      `/api/v1/programme/${jfA}/teilnahmen`,
    );
    expect(antwort.status).toBe(200);
    const koerper = await antwort.json();
    const jfAnamen = koerper.teilnehmende.map(
      (t: { id: string; status: string }) => [t.id, t.status],
    );
    expect(jfAnamen).toEqual(
      expect.arrayContaining([[welt.teilnehmende.jfA, "ja"]]),
    );
    // Nur Personen der eigenen Einheit
    expect(JSON.stringify(koerper)).not.toContain(welt.teilnehmende.kfA);
    expect(JSON.stringify(koerper)).not.toContain(welt.teilnehmende.jfB);
    expect(koerper.zahlen.teilnehmende.ja).toBeGreaterThanOrEqual(1);
    expect(
      koerper.leitende.find((l: { id: string }) => l.id === leitung.id).status,
    ).toBe("nein");
    // Kommandant zuerst, dann Stellvertretung, dann Leitende
    const rollen = koerper.leitende.map((l: { rolle: string }) => l.rolle);
    expect(rollen.indexOf("kommandant")).toBeLessThan(
      rollen.indexOf("stellvertretung"),
    );
    expect(rollen.indexOf("stellvertretung")).toBeLessThan(
      rollen.indexOf("leitung"),
    );
    expect(koerper.leitende.map((l: { id: string }) => l.id)).toEqual(
      expect.arrayContaining([kommando.id, stv.id, leitung.id]),
    );
  });

  test("Teilnehmende und Leitende tragen ihr Abzeichen; ohne Rang null", async () => {
    const kommando = await person("kommandoJfA");
    await db
      .update(schema.teilnehmende)
      .set({ rangId: welt.rangId })
      .where(eq(schema.teilnehmende.id, welt.teilnehmende.jfA));
    await db
      .update(schema.einheitRolle)
      .set({ rangId: welt.rangId })
      .where(eq(schema.einheitRolle.userId, kommando.id!));
    try {
      const koerper = await lies(
        kommando,
        `/api/v1/programme/${jfA}/teilnahmen`,
      );
      const erwartet = { kuerzel: "R1", sterne: 1, bildUrl: null };
      expect(
        koerper.teilnehmende.find(
          (t: { id: string }) => t.id === welt.teilnehmende.jfA,
        ).abzeichen,
      ).toEqual(erwartet);
      expect(
        koerper.leitende.find((l: { id: string }) => l.id === kommando.id)
          .abzeichen,
      ).toEqual(erwartet);
      // Die Hilfsfelder des Rangs gehören nicht in die Antwort
      expect(JSON.stringify(koerper)).not.toContain("rangId");
      expect(
        koerper.teilnehmende.every(
          (t: { id: string; abzeichen: unknown }) =>
            t.id === welt.teilnehmende.jfA || t.abzeichen === null,
        ),
      ).toBe(true);
    } finally {
      await db
        .update(schema.teilnehmende)
        .set({ rangId: null })
        .where(eq(schema.teilnehmende.id, welt.teilnehmende.jfA));
      await db
        .update(schema.einheitRolle)
        .set({ rangId: null })
        .where(eq(schema.einheitRolle.userId, kommando.id!));
    }
  });

  test("Kantonsadmin und Leitende sehen dieselbe Übersicht", async () => {
    const [admin, leitung] = await Promise.all([
      person("kantonsadmin"),
      person("leitendeJfA"),
    ]);
    for (const konto of [admin, leitung]) {
      const koerper = await lies(konto, `/api/v1/programme/${jfA}/teilnahmen`);
      expect(koerper.teilnehmende.length).toBeGreaterThanOrEqual(3);
      expect(koerper.leitende.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("Eltern sehen nur ihre eigene Person, ohne Leitende", async () => {
    const eltern = await person("elternJfA");
    const koerper = await lies(eltern, `/api/v1/programme/${jfA}/teilnahmen`);
    expect(koerper.teilnehmende.map((t: { id: string }) => t.id)).toEqual([
      welt.teilnehmende.jfA,
    ]);
    expect(koerper.leitende).toEqual([]);
  });

  test("eine Leitende, die in KF A nur Elternteil ist, sieht dort nur die eigene Person", async () => {
    const konto = await person("leitendeJfAElternKfA");
    const koerper = await lies(konto, `/api/v1/programme/${kfA}/teilnahmen`);
    expect(koerper.teilnehmende.map((t: { id: string }) => t.id)).toEqual([
      welt.teilnehmende.kfA,
    ]);
    expect(koerper.leitende).toEqual([]);
  });

  test("andere Einheiten: 404; unbekannt: 404; keine UUID: 400", async () => {
    const kommando = await person("kommandoJfA");
    const [kfStatus, bStatus, unbekannt, ungueltig] = await Promise.all([
      senden(kommando, "GET", `/api/v1/programme/${kfA}/teilnahmen`),
      senden(kommando, "GET", `/api/v1/programme/${jfB}/teilnahmen`),
      senden(
        kommando,
        "GET",
        "/api/v1/programme/0198f0a0-0000-7000-8000-000000000000/teilnahmen",
      ),
      senden(kommando, "GET", "/api/v1/programme/kein-uuid/teilnahmen"),
    ]);
    expect([
      kfStatus.status,
      bStatus.status,
      unbekannt.status,
      ungueltig.status,
    ]).toEqual([404, 404, 404, 400]);
  });
});

describe("PUT /api/v1/programme/:id/leitung", () => {
  test.each([
    ["kommandoJfA", 204],
    ["stellvertretung1JfA", 204],
    ["leitendeJfA", 204],
    ["elternJfA", 403],
    ["teilnehmendeSelbstJfA", 403],
    ["kantonsadmin", 403],
    ["kommandoKfA", 404],
    ["kommandoJfB", 404],
    ["elternKfA", 404],
  ] as const)("%s: %i", async (persona, erwartet) => {
    const konto = await person(persona);
    expect((await meldeLeitung(konto, jfA)).status).toBe(erwartet);
  });

  test("ja, dann nein: eine Zeile mit nein, eigeneAnmeldung folgt", async () => {
    const konto = await person("leitendeJfA");
    await meldeLeitung(konto, jfA, "ja");
    expect(
      (await lies(konto, `/api/v1/programme/${jfA}`)).eigeneAnmeldung,
    ).toBe("ja");
    await meldeLeitung(konto, jfA, "nein");
    expect(
      (await lies(konto, `/api/v1/programme/${jfA}`)).eigeneAnmeldung,
    ).toBe("nein");
    const zeilen = await db
      .select()
      .from(schema.leitungAnmeldung)
      .where(
        and(
          eq(schema.leitungAnmeldung.programmId, jfA),
          eq(schema.leitungAnmeldung.userId, konto.id!),
        ),
      );
    expect(zeilen).toHaveLength(1);
  });

  test("zwei gleichzeitige Anfragen: beide 204, eine Zeile", async () => {
    const konto = await person("leitendeJfA");
    const antworten = await Promise.all([
      meldeLeitung(konto, jfA, "ja"),
      meldeLeitung(konto, jfA, "nein"),
    ]);
    expect(antworten.map((a) => a.status)).toEqual([204, 204]);
    const zeilen = await db
      .select()
      .from(schema.leitungAnmeldung)
      .where(
        and(
          eq(schema.leitungAnmeldung.programmId, jfA),
          eq(schema.leitungAnmeldung.userId, konto.id!),
        ),
      );
    expect(zeilen).toHaveLength(1);
  });

  test("nach dem Beginn: 409 mit eigenem Code; 404 und 403 gehen vor", async () => {
    const [leitung, eltern, fremd] = await Promise.all([
      person("leitendeJfA"),
      person("elternJfA"),
      person("kommandoKfA"),
    ]);
    const antwort = await meldeLeitung(leitung, vorbei);
    expect(antwort.status).toBe(409);
    expect(await antwort.json()).toMatchObject({ code: "PROGRAMM_BEGONNEN" });
    expect((await meldeLeitung(eltern, vorbei)).status).toBe(403);
    expect((await meldeLeitung(fremd, vorbei)).status).toBe(404);
  });

  test("ungültiger Status und fremde Felder: 400", async () => {
    const konto = await person("leitendeJfA");
    for (const body of [{ status: "offen" }, { status: "ja", x: 1 }, {}]) {
      expect(
        (await senden(konto, "PUT", `/api/v1/programme/${jfA}/leitung`, body))
          .status,
      ).toBe(400);
    }
  });

  test("eigeneAnmeldung steht nur bei Kommando und Leitung der Einheit", async () => {
    const lesen = async (persona: Persona) =>
      lies(await person(persona), `/api/v1/programme/${jfA}`);
    expect(await lesen("kommandoJfA")).toHaveProperty("eigeneAnmeldung");
    expect(await lesen("leitendeJfA")).toHaveProperty("eigeneAnmeldung");
    expect(await lesen("elternJfA")).not.toHaveProperty("eigeneAnmeldung");
    expect(await lesen("kantonsadmin")).not.toHaveProperty("eigeneAnmeldung");
  });

  test("die Liste trägt eigeneAnmeldung mit derselben Regel und folgt der Antwort", async () => {
    const jahr = new Date().getFullYear();
    const konten = new Map<Persona, PersonaKonto>();
    const liste = async (persona: Persona) => {
      if (!konten.has(persona)) konten.set(persona, await person(persona));
      const antwort = await lies(
        konten.get(persona)!,
        `/api/v1/programme?von=${jahr}-01-01&bis=${jahr + 1}-12-31`,
      );
      return antwort.programme.find((p: { id: string }) => p.id === jfA);
    };
    expect(await liste("leitendeJfA")).toHaveProperty("eigeneAnmeldung");
    expect(await liste("kommandoJfA")).toHaveProperty("eigeneAnmeldung");
    expect(await liste("elternJfA")).not.toHaveProperty("eigeneAnmeldung");
    expect(await liste("teilnehmendeSelbstJfA")).not.toHaveProperty(
      "eigeneAnmeldung",
    );
    expect(await liste("kantonsadmin")).not.toHaveProperty("eigeneAnmeldung");
    await liste("leitendeJfA");
    await meldeLeitung(konten.get("leitendeJfA")!, jfA, "ja");
    expect((await liste("leitendeJfA")).eigeneAnmeldung).toBe("ja");
    // Nur die eigene Anmeldung zählt
    expect((await liste("kommandoJfA")).eigeneAnmeldung).toBe("offen");
  });
});

describe("Termine einer Art ohne Anmeldung", () => {
  const sitzung = () =>
    legeProgrammAn(db, {
      einheitId: welt.einheit.jfA,
      beginn: IN_ZEHN_TAGEN(),
      art: "Sitzung",
      anmeldbar: false,
    }).then((p) => p.id);

  test("Teilnahme und Leitung: 409 KEINE_ANMELDUNG, auch im offenen Fenster", async () => {
    const id = await sitzung();
    const eltern = await person("elternJfA");
    const antwort = await melde(eltern, id, welt.teilnehmende.jfA);
    expect(antwort.status).toBe(409);
    expect(await antwort.json()).toMatchObject({ code: "KEINE_ANMELDUNG" });
    const leitung = await meldeLeitung(await person("leitendeJfA"), id);
    expect(leitung.status).toBe(409);
    expect(await leitung.json()).toMatchObject({ code: "KEINE_ANMELDUNG" });
    expect(
      await db
        .select()
        .from(schema.teilnahme)
        .where(eq(schema.teilnahme.programmId, id)),
    ).toHaveLength(0);
  });

  test("der Termin bleibt im Kalender, ohne Anmeldung", async () => {
    const id = await sitzung();
    const eltern = await person("elternJfA");
    const detail = await lies(eltern, `/api/v1/programme/${id}`);
    expect(detail).toMatchObject({
      art: "Sitzung",
      anmeldbar: false,
      teilnahmeOffen: false,
      teilnehmende: [],
    });
    const leitung = await lies(
      await person("leitendeJfA"),
      `/api/v1/programme/${id}`,
    );
    expect(leitung).not.toHaveProperty("eigeneAnmeldung");

    const jahr = new Date().getFullYear();
    const liste = await lies(
      eltern,
      `/api/v1/programme?von=${jahr}-01-01&bis=${jahr + 1}-12-31`,
    );
    const eintrag = liste.programme.find((p: { id: string }) => p.id === id);
    expect(eintrag).toMatchObject({
      art: "Sitzung",
      anmeldbar: false,
      teilnahmeOffen: false,
      teilnehmende: [],
    });
    const listeLeitung = await lies(
      await person("leitendeJfA"),
      `/api/v1/programme?von=${jahr}-01-01&bis=${jahr + 1}-12-31`,
    );
    expect(
      listeLeitung.programme.find((p: { id: string }) => p.id === id),
    ).not.toHaveProperty("eigeneAnmeldung");
    const anmeldbar = liste.programme.find((p: { id: string }) => p.id === jfA);
    expect(anmeldbar).toMatchObject({ anmeldbar: true, teilnahmeOffen: true });
    expect(anmeldbar.teilnehmende).not.toHaveLength(0);
  });

  test("ohne Art ist nichts anmeldbar; eine Freigabe gilt sofort, ihr Entzug auch", async () => {
    const eltern = await person("elternJfA");
    const ohneArt = (
      await legeProgrammAn(db, {
        einheitId: welt.einheit.jfA,
        beginn: IN_ZEHN_TAGEN(),
        art: null,
      })
    ).id;
    expect((await melde(eltern, ohneArt, welt.teilnehmende.jfA)).status).toBe(
      409,
    );
    const kurs = (
      await legeProgrammAn(db, {
        einheitId: welt.einheit.jfA,
        beginn: IN_ZEHN_TAGEN(),
        art: "Kurs",
        anmeldbar: false,
      })
    ).id;
    expect((await melde(eltern, kurs, welt.teilnehmende.jfA)).status).toBe(409);
    await db
      .update(schema.einheit)
      .set({ anmeldeArten: ["Übung", "Kurs"] })
      .where(eq(schema.einheit.id, welt.einheit.jfA));
    expect((await melde(eltern, kurs, welt.teilnehmende.jfA)).status).toBe(204);
    // Wieder abgewählt: die Antwort bleibt gespeichert, ändern geht nicht mehr
    await db
      .update(schema.einheit)
      .set({ anmeldeArten: ["Übung"] })
      .where(eq(schema.einheit.id, welt.einheit.jfA));
    expect(
      (await melde(eltern, kurs, welt.teilnehmende.jfA, "nein")).status,
    ).toBe(409);
    expect(
      await db
        .select()
        .from(schema.teilnahme)
        .where(eq(schema.teilnahme.programmId, kurs)),
    ).toHaveLength(1);
  });
});
