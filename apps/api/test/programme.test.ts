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

// Alle zwölf Kombinationen Sichtbarkeit × Stufen der Testabteilung, dazu ein Eltern-Programm der Demo-Abteilung
const NAMEN = [
  "intern",
  "intern-A",
  "intern-B",
  "intern-AB",
  "leitende",
  "leitende-A",
  "leitende-B",
  "leitende-AB",
  "eltern",
  "eltern-A",
  "eltern-B",
  "eltern-AB",
  "demo",
] as const;
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
        const demo = name === "demo";
        const [sichtbarkeit, gruppe = ""] = demo
          ? (["eltern", "Demo"] as const)
          : (name.split("-") as ["intern" | "leitende" | "eltern", string?]);
        const kombis: Record<string, string[]> = {
          "": [],
          A: [welt.stufeAId],
          B: [welt.stufeBId],
          AB: [welt.stufeAId, welt.stufeBId],
          Demo: [welt.demoStufeId],
        };
        const p = await legeProgrammAn(db, {
          abteilungId: demo ? welt.demoAbteilungId : welt.testabteilungId,
          sichtbarkeit,
          stufen: kombis[gruppe],
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

const MIT_ALLEN = Object.fromEntries(
  NAMEN.filter((n) => n !== "demo").map((n) => [n, true]),
) as Partial<Record<Name, boolean>>;

// true: mit Google-Beschreibung (Leitungssicht), false: ohne; fehlt der Eintrag, ist das Programm unsichtbar (404)
const SICHT: Record<
  Exclude<Persona, "deaktiviert" | "ohneLogin" | "mussPasswortAendern">,
  Partial<Record<Name, boolean>>
> = {
  admin: MIT_ALLEN,
  // #23 sperrt Admins ohne zweiten Faktor nur unter /api/v1/admin/*; hier zählt allein die Rolle
  adminOhneZweitenFaktor: MIT_ALLEN,
  slA: MIT_ALLEN,
  slB: MIT_ALLEN,
  leitendeA: {
    "leitende-A": true,
    "leitende-AB": true,
    "eltern-A": true,
    "eltern-AB": true,
  },
  leitendeB: {
    "leitende-B": true,
    "leitende-AB": true,
    "eltern-B": true,
    "eltern-AB": true,
  },
  leitendeAElternB: {
    "leitende-A": true,
    "leitende-AB": true,
    "eltern-A": true,
    "eltern-AB": true,
    "eltern-B": false,
  },
  elternA: { "eltern-A": false, "eltern-AB": false },
  elternB: { "eltern-B": false, "eltern-AB": false },
  demoAdmin: { demo: true },
  demoEltern: { demo: false },
};

describe("Liste und Detail: jede Sichtbarkeit mal jede Persona", () => {
  test.each(PERSONAS)("%s", async (persona) => {
    const { headers } = konten[persona];
    const liste = await app.request(`/api/v1/programme?${FENSTER}`, {
      headers,
    });
    if (persona === "deaktiviert" || persona === "ohneLogin") {
      expect(liste.status).toBe(401);
      const detail = await app.request(
        `/api/v1/programme/${programme.intern.id}`,
        { headers },
      );
      expect(detail.status).toBe(401);
      return;
    }
    // #15 sperrt das Konto bis zum Pflichtwechsel auf allen Routen ausser GET /api/v1/ich
    if (persona === "mussPasswortAendern") {
      expect(liste.status).toBe(403);
      const detail = await app.request(
        `/api/v1/programme/${programme.intern.id}`,
        { headers },
      );
      expect(detail.status).toBe(403);
      return;
    }
    const sicht = SICHT[persona];
    expect(liste.status).toBe(200);
    const { programme: zeilen } = (await liste.json()) as {
      programme: { id: string; googleBeschreibung: string | null }[];
    };
    expect(zeilen.map((z) => z.id)).toEqual(
      NAMEN.filter((n) => n in sicht).map((n) => programme[n].id),
    );
    for (const zeile of zeilen) {
      const name = NAMEN.find((n) => programme[n].id === zeile.id) as Name;
      expect(zeile.googleBeschreibung, name).toBe(
        sicht[name] ? programme[name].marke : null,
      );
    }
    for (const name of NAMEN) {
      const res = await app.request(`/api/v1/programme/${programme[name].id}`, {
        headers,
      });
      const beschreibung = sicht[name];
      if (beschreibung === undefined) {
        expect(res.status, name).toBe(404);
        continue;
      }
      expect(res.status, name).toBe(200);
      const koerper = (await res.json()) as {
        googleBeschreibung: string | null;
      };
      expect(koerper.googleBeschreibung, name).toBe(
        beschreibung ? programme[name].marke : null,
      );
    }
  });

  test("keine Marke einer Google-Beschreibung erreicht Eltern", async () => {
    const { headers } = konten.elternA;
    const antworten = [
      await app.request(`/api/v1/programme?${FENSTER}`, { headers }),
      await app.request(`/api/v1/programme/${programme["eltern-A"].id}`, {
        headers,
      }),
      await app.request(`/api/v1/programme/${programme["eltern-AB"].id}`, {
        headers,
      }),
    ];
    for (const antwort of antworten) {
      const text = JSON.stringify(await antwort.json());
      for (const { marke } of Object.values(programme)) {
        expect(text).not.toContain(marke);
      }
    }
  });

  test("Eltern-Detail: genau die Felder der App", async () => {
    const res = await app.request(
      `/api/v1/programme/${programme["eltern-A"].id}`,
      { headers: konten.elternA.headers },
    );
    expect(res.status).toBe(200);
    const koerper = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(koerper).sort()).toEqual(
      [
        "id",
        "titel",
        "status",
        "sichtbarkeit",
        "ganztaegig",
        "beginn",
        "ende",
        "tagVon",
        "tagBis",
        "googleOrt",
        "stufen",
        "googleBeschreibung",
        "teilnahmeOffen",
        "kinder",
      ].sort(),
    );
    expect(koerper.googleBeschreibung).toBeNull();
    // Der Google-Ort bleibt sichtbar
    expect(koerper.googleOrt).toBe("Google-Ort");
    expect(koerper.stufen).toEqual([{ id: welt.stufeAId, name: "Stufe A" }]);
  });

  test("die Stufen eines Abteilungsanlasses kommen sortiert, mit Namen", async () => {
    const res = await app.request(
      `/api/v1/programme/${programme["eltern-AB"].id}`,
      { headers: konten.admin.headers },
    );
    const koerper = (await res.json()) as {
      stufen: { id: string; name: string }[];
    };
    const namen: Record<string, string> = {
      [welt.stufeAId]: "Stufe A",
      [welt.stufeBId]: "Stufe B",
    };
    expect(koerper.stufen).toEqual(
      [welt.stufeAId, welt.stufeBId].sort().map((id) => ({
        id,
        name: namen[id],
      })),
    );
  });

  test("der Name einer fremden Stufe erreicht keine andere Abteilung", async () => {
    // Quer verknüpft wie nach einem Fehler: Die Antwort lässt die fremde Stufe trotzdem weg
    const quer = await legeProgrammAn(db, {
      abteilungId: welt.testabteilungId,
      sichtbarkeit: "eltern",
      stufen: [welt.stufeAId, welt.demoStufeId],
      titel: "quer",
      // April: ausserhalb des Persona-Fensters und der Fenster-Tests
      beginn: new Date(Date.UTC(2027, 3, 10, 8)),
    });
    const res = await app.request(`/api/v1/programme/${quer.id}`, {
      headers: konten.elternA.headers,
    });
    expect(res.status).toBe(200);
    const koerper = (await res.json()) as {
      stufen: { id: string; name: string }[];
    };
    expect(koerper.stufen).toEqual([{ id: welt.stufeAId, name: "Stufe A" }]);
    expect(JSON.stringify(koerper)).not.toContain("Demo-Stufe");
  });

  test("ein inaktives Kind gibt keine Elternsicht", async () => {
    // Eigenes Kind und eigene Verknüpfung: Die geteilten Kinder A und B gehören der Persona-Tabelle
    const konto = await legePersonaAn(welt, "elternB");
    const [inaktives] = await db
      .insert(schema.kind)
      .values({
        abteilungId: welt.testabteilungId,
        vorname: "Kind",
        nachname: "Inaktiv",
        stufeId: welt.stufeAId,
        inaktivSeit: new Date(),
      })
      .returning({ id: schema.kind.id });
    await db
      .insert(schema.kindEltern)
      .values({ kindId: inaktives.id, userId: konto.id as string });
    const [a, b] = await Promise.all([
      app.request(`/api/v1/programme/${programme["eltern-A"].id}`, {
        headers: konto.headers,
      }),
      app.request(`/api/v1/programme/${programme["eltern-B"].id}`, {
        headers: konto.headers,
      }),
    ]);
    // Das aktive Kind B trägt die Sicht, das inaktive in Stufe A nicht
    expect({ a: a.status, b: b.status }).toEqual({ a: 404, b: 200 });
  });
});

describe("Zeitfenster in Schweizer Kalendertagen", () => {
  const liste = async (von: string, bis: string) => {
    const res = await app.request(`/api/v1/programme?von=${von}&bis=${bis}`, {
      headers: konten.admin.headers,
    });
    expect(res.status).toBe(200);
    const { programme: zeilen } = (await res.json()) as {
      programme: { id: string }[];
    };
    return zeilen.map((z) => z.id);
  };

  test("ein Lager zählt bis zu seinem letzten Tag", async () => {
    const lager = await legeProgrammAn(db, {
      abteilungId: welt.testabteilungId,
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
      abteilungId: welt.testabteilungId,
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
      abteilungId: welt.testabteilungId,
      beginn: new Date("2027-05-10T08:00:00Z"),
    });
    const ganztaegig = await legeProgrammAn(db, {
      abteilungId: welt.testabteilungId,
      tagVon: "2027-05-10",
    });
    const frueh = await legeProgrammAn(db, {
      abteilungId: welt.testabteilungId,
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
    const res = await app.request(url, { headers: konten.admin.headers });
    expect(res.status).toBe(400);
  });
});
