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
import {
  einheitenFuer,
  pruefeEinheit,
  type Person,
  type Zweck,
} from "../src/rechte.js";
import { ladeSeiten } from "../src/seiten.js";
import { bereiteAuthTestsVor, erstelleTestAuth } from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  PERSONAS,
  type EinheitKey,
  type Persona,
  type PersonaKonto,
  type Welt,
} from "./hilfen/personas.js";

bereiteAuthTestsVor();

const sql = postgres(API_URL);
const db = erstelleDb(sql);
const auth = erstelleTestAuth(db);
afterAll(() => sql.end());

// Testroute wie eine spätere Objekt-Route: erst die Einheit prüfen (404 für Fremde), dann das Recht für den Zweck (403)
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  seiten: ladeSeiten(),
}).get("/api/v1/test/einheiten/:id/:zweck", async (c) => {
  const person = c.get("person");
  await pruefeEinheit(
    db,
    person,
    c.req.param("id"),
    c.req.param("zweck") as Zweck,
  );
  return c.json({ id: c.req.param("id") });
});

// Jede Anfrage schriebe sonst eine Log-Zeile in die Testausgabe
let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

let welt: Welt;
let konten: Record<Persona, PersonaKonto>;
let personen: Record<Persona, Person | null>;

// Die Person, wie die Middleware sie aus der Sitzung baut, ohne die Route zu kennen
async function personVon(konto: PersonaKonto): Promise<Person> {
  const sitzung = await auth.api.getSession({ headers: konto.headers });
  const id = sitzung!.user.id;
  const rollen = await db
    .select()
    .from(schema.einheitRolle)
    .where(eq(schema.einheitRolle.userId, id));
  const konten = await db
    .select({ einheitId: schema.teilnehmende.einheitId })
    .from(schema.teilnehmendeKonto)
    .innerJoin(
      schema.teilnehmende,
      eq(schema.teilnehmende.id, schema.teilnehmendeKonto.teilnehmendeId),
    )
    .where(eq(schema.teilnehmendeKonto.userId, id));
  return {
    id,
    kantonsadmin: sitzung!.user.role === "admin",
    zweiterFaktor: false,
    einwilligung: true,
    einheiten: rollen.map((r) => ({ einheitId: r.einheitId, typ: r.typ })),
    teilnehmendeEinheiten: konten.map((k) => k.einheitId),
  };
}

beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  konten = Object.fromEntries(
    await Promise.all(
      PERSONAS.map(async (p) => [p, await legePersonaAn(welt, p)]),
    ),
  ) as Record<Persona, PersonaKonto>;
  personen = Object.fromEntries(
    await Promise.all(
      PERSONAS.map(async (p) => [
        p,
        p === "ohneLogin" || p === "deaktiviert"
          ? null
          : await personVon(konten[p]),
      ]),
    ),
  ) as Record<Persona, Person | null>;
});

const ALLE: EinheitKey[] = ["jfA", "kfA", "jfB", "kfB"];

// Literale Erwartung je Persona und Zweck, nie aus rechte.ts berechnet. Nicht eingetragene Zwecke ergeben eine leere Liste
const ERWARTET: Partial<Record<Persona, Partial<Record<Zweck, EinheitKey[]>>>> =
  {
    kantonsadmin: {
      lesen: ALLE,
      verwalten: ALLE,
      stellvertretungen: ALLE,
    },
    kommandoJfA: {
      lesen: ["jfA"],
      antworten: ["jfA"],
      verwalten: ["jfA"],
      stellvertretungen: ["jfA"],
    },
    stellvertretung1JfA: {
      lesen: ["jfA"],
      antworten: ["jfA"],
      verwalten: ["jfA"],
    },
    stellvertretung2JfA: {
      lesen: ["jfA"],
      antworten: ["jfA"],
      verwalten: ["jfA"],
    },
    kommandoKfA: {
      lesen: ["kfA"],
      antworten: ["kfA"],
      verwalten: ["kfA"],
      stellvertretungen: ["kfA"],
    },
    kommandoJfB: {
      lesen: ["jfB"],
      antworten: ["jfB"],
      verwalten: ["jfB"],
      stellvertretungen: ["jfB"],
    },
    leitendeJfA: { lesen: ["jfA"], antworten: ["jfA"] },
    leitendeJfAElternKfA: { lesen: ["jfA", "kfA"], antworten: ["jfA"] },
    elternJfA: { lesen: ["jfA"] },
    elternAundB: { lesen: ["jfA", "jfB"] },
    elternKfA: { lesen: ["kfA"] },
    teilnehmendeSelbstJfA: { lesen: ["jfA"] },
    elternNachWechsel: { lesen: ["jfA"] },
  };

const ZWECKE: Zweck[] = [
  "lesen",
  "antworten",
  "verwalten",
  "stellvertretungen",
];

describe("einheitenFuer", () => {
  const mitPerson = PERSONAS.filter(
    (p) =>
      p !== "ohneLogin" &&
      p !== "deaktiviert" &&
      p !== "ohneEinwilligung" &&
      p !== "mussPasswortAendern" &&
      p !== "kantonsadminOhneZweitenFaktor" &&
      p !== "kommandoKfBOhneZweitenFaktor",
  );

  test.each(mitPerson)("%s", async (persona) => {
    for (const zweck of ZWECKE) {
      const erwartet = (ERWARTET[persona]?.[zweck] ?? []).map(
        (k) => welt.einheit[k],
      );
      const ist = (await einheitenFuer(db, personen[persona]!, zweck)).filter(
        // Das Kantonsadmin-Konto sieht alle Einheiten der Datenbank, auch die anderer Testdateien
        (id) => Object.values(welt.einheit).includes(id),
      );
      expect([...ist].sort(), `${persona} ${zweck}`).toEqual(
        [...erwartet].sort(),
      );
    }
  });
});

describe("pruefeEinheit: 404 für Fremde, 403 für Sichtbare ohne Recht", () => {
  const anfrage = (persona: Persona, einheit: EinheitKey, zweck: Zweck) =>
    app.request(`/api/v1/test/einheiten/${welt.einheit[einheit]}/${zweck}`, {
      headers: konten[persona].headers,
    });

  test.each([
    ["kommandoJfA", "jfA", "verwalten", 200],
    ["kommandoJfA", "jfA", "stellvertretungen", 200],
    ["stellvertretung1JfA", "jfA", "verwalten", 200],
    ["stellvertretung1JfA", "jfA", "stellvertretungen", 403],
    ["leitendeJfA", "jfA", "lesen", 200],
    ["leitendeJfA", "jfA", "verwalten", 403],
    ["elternJfA", "jfA", "lesen", 200],
    ["elternJfA", "jfA", "antworten", 403],
    ["kantonsadmin", "kfB", "verwalten", 200],
    ["kantonsadmin", "kfB", "antworten", 403],
    // Fremde Einheit desselben Bezirks und fremder Bezirk: unsichtbar
    ["kommandoJfA", "kfA", "lesen", 404],
    ["kommandoJfA", "kfA", "verwalten", 404],
    ["kommandoJfA", "jfB", "lesen", 404],
    ["elternJfA", "kfA", "lesen", 404],
    ["elternNachWechsel", "jfB", "lesen", 404],
  ] as const)(
    "%s in %s für %s: %i",
    async (persona, einheit, zweck, status) => {
      expect((await anfrage(persona, einheit, zweck)).status).toBe(status);
    },
  );

  test("ohne Sitzung 401, deaktiviert 401, im einheitlichen Fehlerformat", async () => {
    for (const persona of ["ohneLogin", "deaktiviert"] as const) {
      const antwort = await anfrage(persona, "jfA", "lesen");
      expect(antwort.status).toBe(401);
      expect(await antwort.json()).toEqual({
        code: "NICHT_ANGEMELDET",
        message: "Nicht angemeldet",
      });
    }
    const verboten = await anfrage("leitendeJfA", "jfA", "verwalten");
    expect(await verboten.json()).toEqual({
      code: "KEINE_BERECHTIGUNG",
      message: "Keine Berechtigung",
    });
    const fremd = await anfrage("kommandoJfA", "kfA", "lesen");
    expect(await fremd.json()).toEqual({
      code: "NICHT_GEFUNDEN",
      message: "Nicht gefunden",
    });
  });
});

describe("person aus der Sitzung", () => {
  test("banned mit noch bestehender Sitzung: 401", async () => {
    const konto = await legePersonaAn(welt, "elternJfA");
    expect(
      (
        await app.request(`/api/v1/test/einheiten/${welt.einheit.jfA}/lesen`, {
          headers: konto.headers,
        })
      ).status,
    ).toBe(200);
    await db
      .update(schema.user)
      .set({ banned: true })
      .where(eq(schema.user.id, konto.id!));
    expect(
      (
        await app.request(`/api/v1/test/einheiten/${welt.einheit.jfA}/lesen`, {
          headers: konto.headers,
        })
      ).status,
    ).toBe(401);
  });

  test("eine inaktive teilnehmende Person gibt keinen Zugang zur Einheit", async () => {
    const konto = await legePersonaAn(welt, "elternKfA");
    await db
      .update(schema.teilnehmende)
      .set({ inaktivSeit: new Date() })
      .where(eq(schema.teilnehmende.id, welt.teilnehmende.kfA));
    const antwort = await app.request(
      `/api/v1/test/einheiten/${welt.einheit.kfA}/lesen`,
      { headers: konto.headers },
    );
    expect(antwort.status).toBe(404);
    await db
      .update(schema.teilnehmende)
      .set({ inaktivSeit: null })
      .where(eq(schema.teilnehmende.id, welt.teilnehmende.kfA));
  });
});
