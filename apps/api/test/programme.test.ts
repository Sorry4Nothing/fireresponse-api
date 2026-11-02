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
  PERSONAS,
  type Persona,
  type PersonaKonto,
  type Welt,
} from "./hilfen/personas.js";
import { legeProgrammAn, type TestProgramm } from "./hilfen/programme.js";

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

const NAMEN = ["jfA", "kfA", "jfB", "kfB"] as const;
type Name = (typeof NAMEN)[number];

// Das Fenster der Persona-Tabelle; die Fenster-Tests legen ihre Programme in andere Monate
const FENSTER = "von=2027-03-01&bis=2027-03-07";

let welt: Welt;
let konten: Record<Persona, PersonaKonto>;
let programme: Record<Name, TestProgramm>;

beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  konten = Object.fromEntries(
    await Promise.all(
      PERSONAS.map(async (p) => [p, await legePersonaAn(welt, p)]),
    ),
  ) as Record<Persona, PersonaKonto>;
  programme = Object.fromEntries(
    await Promise.all(
      NAMEN.map(async (name, i) => {
        const p = await legeProgrammAn(db, {
          einheitId: welt.einheit[name],
          titel: name,
          // Eine Stunde Abstand: Die Liste muss in dieser Reihenfolge antworten
          beginn: new Date(Date.UTC(2027, 2, 1, 8 + i)),
        });
        return [name, p] as const;
      }),
    ),
  ) as Record<Name, TestProgramm>;
});

// Jede Anfrage schriebe sonst eine Log-Zeile in die Testausgabe
let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

const ALLE = { jfA: true, kfA: true, jfB: true, kfB: true } as const;

// Wer das Programm sieht; fehlt der Eintrag, ist es unsichtbar (404). Der Wert hält fest, ob die Person eine Rolle in der Einheit hat (true) oder nur Eltern oder Teilnehmende ist (false)
const SICHT: Record<
  Exclude<
    Persona,
    "deaktiviert" | "ohneLogin" | "mussPasswortAendern" | "ohneEinwilligung"
  >,
  Partial<Record<Name, boolean>>
> = {
  kantonsadmin: ALLE,
  // Die Sperre ohne zweiten Faktor gilt nur unter /api/v1/admin/*; hier zählt allein die Rolle
  kantonsadminOhneZweitenFaktor: ALLE,
  kommandoJfA: { jfA: true },
  kommandoKfBOhneZweitenFaktor: { kfB: true },
  stellvertretung1JfA: { jfA: true },
  stellvertretung2JfA: { jfA: true },
  kommandoKfA: { kfA: true },
  kommandoJfB: { jfB: true },
  leitendeJfA: { jfA: true },
  leitendeJfAElternKfA: { jfA: true, kfA: false },
  elternJfA: { jfA: false },
  elternAundB: { jfA: false, jfB: false },
  elternKfA: { kfA: false },
  teilnehmendeSelbstJfA: { jfA: false },
  elternNachWechsel: { jfA: false },
};

describe("Liste und Detail: jede Einheit mal jede Persona", () => {
  test.each(PERSONAS)("%s", async (persona) => {
    const { headers } = konten[persona];
    const liste = await app.request(`/api/v1/programme?${FENSTER}`, {
      headers,
    });
    const detail = (name: Name) =>
      app.request(`/api/v1/programme/${programme[name].id}`, { headers });
    if (persona === "deaktiviert" || persona === "ohneLogin") {
      expect(liste.status).toBe(401);
      expect((await detail("jfA")).status).toBe(401);
      return;
    }
    // Das Konto ist bis zum Pflichtwechsel und bis zur Einwilligung auf allen Routen gesperrt, ausser GET /api/v1/ich
    if (persona === "mussPasswortAendern" || persona === "ohneEinwilligung") {
      expect(liste.status).toBe(403);
      expect((await detail("jfA")).status).toBe(403);
      return;
    }
    const sicht = SICHT[persona];
    expect(liste.status).toBe(200);
    const { programme: zeilen } = (await liste.json()) as {
      programme: { id: string }[];
    };
    // Das Konto des Kantonsadmins sieht alle Einheiten, auch die Programme anderer Testdateien im selben Fenster
    const eigene = new Set(NAMEN.map((n) => programme[n].id));
    expect(zeilen.filter((z) => eigene.has(z.id)).map((z) => z.id)).toEqual(
      NAMEN.filter((n) => n in sicht).map((n) => programme[n].id),
    );
    // Die Google-Spalten gibt die API nie aus
    expect(JSON.stringify(zeilen)).not.toContain("google");
    for (const name of NAMEN) {
      const res = await detail(name);
      if (sicht[name] === undefined) {
        expect(res.status, name).toBe(404);
        continue;
      }
      expect(res.status, name).toBe(200);
      // Thema, Info und Aufgebot sehen alle, die das Programm sehen
      expect(await res.json(), name).toMatchObject({
        thema: "Thema",
        info: "Info",
        aufgebot: "Aufgebot",
      });
    }
  });

  test("keine Marke einer Google-Beschreibung erreicht jemanden", async () => {
    const { headers } = konten.kommandoJfA;
    const antworten = [
      await app.request(`/api/v1/programme?${FENSTER}`, { headers }),
      await app.request(`/api/v1/programme/${programme.jfA.id}`, { headers }),
    ];
    for (const antwort of antworten) {
      const text = JSON.stringify(await antwort.json());
      for (const { marke } of Object.values(programme)) {
        expect(text).not.toContain(marke);
      }
    }
  });

  test("Eltern-Detail: genau die Felder der App, mit Name der Einheit", async () => {
    const res = await app.request(`/api/v1/programme/${programme.jfA.id}`, {
      headers: konten.elternJfA.headers,
    });
    expect(res.status).toBe(200);
    const koerper = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(koerper).sort()).toEqual(
      [
        "id",
        "titel",
        "status",
        "ganztaegig",
        "beginn",
        "ende",
        "tagVon",
        "tagBis",
        "art",
        "anmeldbar",
        "anmeldungAb",
        "teilnahmeOffen",
        "einheit",
        "teilnehmende",
        "thema",
        "info",
        "aufgebot",
        "kontakt",
      ].sort(),
    );
    expect(koerper.einheit).toEqual({
      id: welt.einheit.jfA,
      name: "JF A",
      typ: "jf",
    });
    expect(koerper.teilnehmende).toEqual([
      {
        id: welt.teilnehmende.jfA,
        vorname: "Person",
        status: null,
        abzeichen: null,
      },
    ]);
  });

  test("Kommando und Leitende bekommen ihre eigene Anmeldung, Eltern den Schlüssel nicht", async () => {
    const lesen = async (persona: Persona) =>
      (await (
        await app.request(`/api/v1/programme/${programme.jfA.id}`, {
          headers: konten[persona].headers,
        })
      ).json()) as Record<string, unknown>;
    expect(await lesen("kommandoJfA")).toMatchObject({
      eigeneAnmeldung: "offen",
    });
    expect(await lesen("leitendeJfA")).toMatchObject({
      eigeneAnmeldung: "offen",
    });
    expect(await lesen("elternJfA")).not.toHaveProperty("eigeneAnmeldung");
    expect(await lesen("kantonsadmin")).not.toHaveProperty("eigeneAnmeldung");
  });

  test("eine inaktive teilnehmende Person gibt keine Sicht", async () => {
    // Eigene Person und eigene Verknüpfung: Die geteilten Teilnehmenden gehören der Persona-Tabelle
    const konto = await legePersonaAn(welt, "elternKfA");
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
      teilnehmendeId: inaktiv.id,
      userId: konto.id as string,
      art: "eltern",
    });
    const [a, b] = await Promise.all([
      app.request(`/api/v1/programme/${programme.jfA.id}`, {
        headers: konto.headers,
      }),
      app.request(`/api/v1/programme/${programme.kfA.id}`, {
        headers: konto.headers,
      }),
    ]);
    // Die aktive Person in KF A trägt die Sicht, die inaktive in JF A nicht
    expect({ a: a.status, b: b.status }).toEqual({ a: 404, b: 200 });
  });
});

describe("Zeitfenster in Schweizer Kalendertagen", () => {
  const liste = async (von: string, bis: string) => {
    const res = await app.request(`/api/v1/programme?von=${von}&bis=${bis}`, {
      headers: konten.kantonsadmin.headers,
    });
    expect(res.status).toBe(200);
    const { programme: zeilen } = (await res.json()) as {
      programme: { id: string }[];
    };
    return zeilen.map((z) => z.id);
  };

  test("ein Lager zählt bis zu seinem letzten Tag", async () => {
    const lager = await legeProgrammAn(db, {
      einheitId: welt.einheit.jfA,
      titel: "Lager",
      tagVon: "2027-07-30",
      tagBis: "2027-08-02",
    });
    expect(await liste("2027-08-02", "2027-08-31")).toContain(lager.id);
    expect(await liste("2027-08-03", "2027-08-31")).not.toContain(lager.id);
  });

  test("kurz nach Mitternacht Schweizer Zeit zählt zum neuen Tag", async () => {
    // 22:30Z am 30.10. ist 00:30 Sommerzeit am 31.10.
    const nacht = await legeProgrammAn(db, {
      einheitId: welt.einheit.jfA,
      titel: "Nachtübung",
      beginn: new Date("2027-10-30T22:30:00Z"),
      ende: new Date("2027-10-30T23:30:00Z"),
    });
    expect(await liste("2027-10-31", "2027-10-31")).toContain(nacht.id);
    expect(await liste("2027-10-30", "2027-10-30")).not.toContain(nacht.id);
  });

  test("von nach bis: leere Liste", async () => {
    expect(await liste("2027-03-07", "2027-03-01")).toEqual([]);
  });

  test("Reihenfolge nach Beginn; ganztägige ab Mitternacht Schweizer Zeit", async () => {
    const spaet = await legeProgrammAn(db, {
      einheitId: welt.einheit.jfA,
      beginn: new Date("2027-05-10T08:00:00Z"),
    });
    const ganztaegig = await legeProgrammAn(db, {
      einheitId: welt.einheit.jfA,
      tagVon: "2027-05-10",
    });
    const frueh = await legeProgrammAn(db, {
      einheitId: welt.einheit.jfA,
      beginn: new Date("2027-05-09T07:00:00Z"),
    });
    expect(await liste("2027-05-01", "2027-05-31")).toEqual([
      frueh.id,
      ganztaegig.id,
      spaet.id,
    ]);
  });
});

describe("ungültige Eingaben: 400", () => {
  test.each([
    ["ohne von und bis", "/api/v1/programme"],
    ["ohne bis", "/api/v1/programme?von=2027-01-01"],
    ["kein Kalendertag", "/api/v1/programme?von=2027-02-29&bis=2027-03-01"],
    ["Jahr 0000", "/api/v1/programme?von=0000-01-01&bis=2027-01-01"],
    ["unbekannter Parameter", `/api/v1/programme?${FENSTER}&extra=1`],
    ["wiederholtes von", `/api/v1/programme?von=2027-03-01&${FENSTER}`],
    ["ungültige ID", "/api/v1/programme/kein-uuid"],
  ])("%s", async (_titel, url) => {
    const res = await app.request(url, {
      headers: konten.kantonsadmin.headers,
    });
    expect(res.status).toBe(400);
  });
});
