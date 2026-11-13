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
import { legeProgrammAn } from "./hilfen/programme.js";

bereiteAuthTestsVor();

const sql = postgres(API_URL);
const db = erstelleDb(sql);
const auth = erstelleTestAuth(db);
const grundlage = {
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  seiten: ladeSeiten(),
};
const app = erstelleApp(grundlage);
// Ein kürzeres Fenster, wie es ANMELDEFENSTER_TAGE setzt
const appSiebenTage = erstelleApp({ ...grundlage, anmeldefensterTage: 7 });
afterAll(() => sql.end());

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

const TAG = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich" });
// Mittag UTC am Schweizer Tag «heute + n»: Das Datum ist in beiden Zonen dasselbe
const tagPlus = (n: number) => {
  const tag = new Date(`${TAG.format(new Date())}T12:00:00Z`);
  tag.setUTCDate(tag.getUTCDate() + n);
  return tag;
};
const tagText = (n: number) => tagPlus(n).toISOString().slice(0, 10);

let welt: Welt;
let konten: Partial<Record<Persona, PersonaKonto>>;
const konto = (persona: Persona) => konten[persona]!;

const PERSONEN: Persona[] = [
  "kantonsadmin",
  "kommandoJfA",
  "stellvertretung1JfA",
  "stellvertretung2JfA",
  "leitendeJfA",
  "elternJfA",
  "elternKfA",
];

beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  konten = Object.fromEntries(
    await Promise.all(
      PERSONEN.map(async (p) => [p, await legePersonaAn(welt, p)]),
    ),
  );
  // Nummern für die drei Kontakte der Einheit
  for (const p of [
    "kommandoJfA",
    "stellvertretung1JfA",
    "stellvertretung2JfA",
  ] as const) {
    await db
      .update(schema.user)
      .set({ telefon: "+41790000000" })
      .where(eq(schema.user.id, konto(p).id!));
  }
});

const senden = (
  persona: Persona,
  methode: "GET" | "PUT",
  pfad: string,
  body?: unknown,
  instanz = app,
) =>
  instanz.request(pfad, {
    method: methode,
    headers: { ...konto(persona).headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// Die Tests prüfen einzelne Felder; die Form steht in der OpenAPI-Beschreibung
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const detail = async (persona: Persona, programmId: string) =>
  (await (
    await senden(persona, "GET", `/api/v1/programme/${programmId}`)
  ).json()) as Json;

const meldeKind = (
  persona: Persona,
  programmId: string,
  status = "ja",
  instanz = app,
) =>
  senden(
    persona,
    "PUT",
    `/api/v1/programme/${programmId}/teilnahmen/${welt.teilnehmende.jfA}`,
    { status },
    instanz,
  );

const meldeLeitung = (persona: Persona, programmId: string, status: string) =>
  senden(persona, "PUT", `/api/v1/programme/${programmId}/leitung`, {
    status,
  });

const anlegen = (beginn: Date, status?: "abgesagt") =>
  legeProgrammAn(db, { einheitId: welt.einheit.jfA, beginn }).then(
    async (p) => {
      if (status) {
        await db
          .update(schema.programm)
          .set({ status })
          .where(eq(schema.programm.id, p.id));
      }
      return p.id;
    },
  );

describe("Anmeldefenster", () => {
  test("am Tag der Öffnung geht die Anmeldung, einen Tag früher 409 mit dem Tag in der Meldung", async () => {
    const offen = await anlegen(tagPlus(42));
    const zu = await anlegen(tagPlus(43));

    expect((await meldeKind("elternJfA", offen)).status).toBe(204);
    expect((await detail("elternJfA", offen)).teilnahmeOffen).toBe(true);
    expect((await detail("elternJfA", offen)).anmeldungAb).toBe(tagText(0));

    const kind = await meldeKind("elternJfA", zu);
    expect(kind.status).toBe(409);
    const [jahr, monat, tag] = tagText(1).split("-");
    expect(await kind.json()).toEqual({
      code: "ANMELDEFENSTER_NICHT_OFFEN",
      message: `Die Anmeldung öffnet am ${tag}.${monat}.${jahr}.`,
    });
    const leitung = await meldeLeitung("kommandoJfA", zu, "ja");
    expect(leitung.status).toBe(409);
    expect(await leitung.json()).toMatchObject({
      code: "ANMELDEFENSTER_NICHT_OFFEN",
    });
    // Lesen bleibt erlaubt, nichts wurde gespeichert
    const eintrag = await detail("elternJfA", zu);
    expect(eintrag).toMatchObject({
      teilnahmeOffen: false,
      anmeldungAb: tagText(1),
    });
    expect(eintrag.teilnehmende[0].status).toBeNull();
    expect((await detail("kommandoJfA", zu)).eigeneAnmeldung).toBe("offen");
  });

  test("die Liste zeigt spätere Termine mit «Anmeldung ab»", async () => {
    const spaet = await anlegen(tagPlus(100));
    const antwort = await senden(
      "elternJfA",
      "GET",
      `/api/v1/programme?von=${tagText(99)}&bis=${tagText(101)}`,
    );
    const { programme } = (await antwort.json()) as {
      programme: { id: string; anmeldungAb: string; teilnahmeOffen: boolean }[];
    };
    expect(programme.find((p) => p.id === spaet)).toMatchObject({
      anmeldungAb: tagText(58),
      teilnahmeOffen: false,
    });
  });

  test("ein abgesagter Termin bleibt PROGRAMM_GESCHLOSSEN, auch vor dem Fenster", async () => {
    const abgesagt = await anlegen(tagPlus(60), "abgesagt");
    const antwort = await meldeKind("elternJfA", abgesagt);
    expect(antwort.status).toBe(409);
    expect(await antwort.json()).toMatchObject({
      code: "PROGRAMM_GESCHLOSSEN",
    });
  });

  test("die Zahl der Tage kommt aus der Konfiguration", async () => {
    const inZehnTagen = await anlegen(tagPlus(10));
    expect(
      (await meldeKind("elternJfA", inZehnTagen, "ja", appSiebenTage)).status,
    ).toBe(409);
    expect((await meldeKind("elternJfA", inZehnTagen)).status).toBe(204);
  });

  test("zwei Elternteile: die letzte Antwort gilt", async () => {
    const zweite = await legePersonaAn(welt, "elternJfA");
    const programmId = await anlegen(tagPlus(5));
    const antwort = (kopf: PersonaKonto, status: string) =>
      app.request(
        `/api/v1/programme/${programmId}/teilnahmen/${welt.teilnehmende.jfA}`,
        {
          method: "PUT",
          headers: { ...kopf.headers, "content-type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
    const status = async (kopf: PersonaKonto) =>
      (
        (await (
          await app.request(`/api/v1/programme/${programmId}`, {
            headers: kopf.headers,
          })
        ).json()) as { teilnehmende: { status: string }[] }
      ).teilnehmende[0].status;

    expect((await antwort(konto("elternJfA"), "ja")).status).toBe(204);
    expect((await antwort(zweite, "nein")).status).toBe(204);
    expect(await status(konto("elternJfA"))).toBe("nein");
    expect((await antwort(konto("elternJfA"), "ja")).status).toBe(204);
    expect(await status(zweite)).toBe("ja");
  });
});

describe("Kontakt pro Termin", () => {
  test("Kommandant/in, dann Stellvertretungen der Reihe nach, bei lauter «nein» wieder Kommandant/in; «offen» ist keine Absage", async () => {
    const programmId = await anlegen(tagPlus(10));
    const anderes = await anlegen(tagPlus(11));
    const kontakt = async (persona: Persona = "elternJfA") =>
      (await detail(persona, programmId)).kontakt;

    expect(await kontakt()).toMatchObject({
      id: konto("kommandoJfA").id,
      rolle: "kommandant",
      name: "Kommando JF A",
    });

    expect((await meldeLeitung("kommandoJfA", programmId, "nein")).status).toBe(
      200,
    );
    expect(await kontakt()).toMatchObject({
      id: konto("stellvertretung1JfA").id,
      rolle: "stellvertretung",
    });
    // Eine andere Absage ändert nichts am Kontakt eines anderen Termins
    expect((await detail("elternJfA", anderes)).kontakt.id).toBe(
      konto("kommandoJfA").id,
    );

    // Eine Stellvertretung, die «ja» sagt, bleibt Kontakt; «offen» der zweiten ändert nichts
    expect(
      (await meldeLeitung("stellvertretung1JfA", programmId, "ja")).status,
    ).toBe(200);
    expect((await kontakt()).id).toBe(konto("stellvertretung1JfA").id);

    expect(
      (await meldeLeitung("stellvertretung1JfA", programmId, "nein")).status,
    ).toBe(200);
    expect((await kontakt()).id).toBe(konto("stellvertretung2JfA").id);

    expect(
      (await meldeLeitung("stellvertretung2JfA", programmId, "nein")).status,
    ).toBe(200);
    expect((await kontakt()).id).toBe(konto("kommandoJfA").id);

    expect((await meldeLeitung("kommandoJfA", programmId, "ja")).status).toBe(
      200,
    );
    expect((await kontakt()).id).toBe(konto("kommandoJfA").id);
  });

  test("die Nummer sehen nur Eltern und Teilnehmende mit aktiver Person in der Einheit", async () => {
    const programmId = await anlegen(tagPlus(12));
    const nummer = async (persona: Persona) =>
      (await detail(persona, programmId)).kontakt.telefon;
    expect(await nummer("elternJfA")).toBe("+41790000000");
    expect(await nummer("leitendeJfA")).toBeNull();
    expect(await nummer("kommandoJfA")).toBeNull();
    expect(await nummer("kantonsadmin")).toBeNull();
  });

  test("das Abzeichen der Kontaktperson kommt vom Rang der Rolle", async () => {
    await db
      .update(schema.einheitRolle)
      .set({ rangId: welt.rangId })
      .where(eq(schema.einheitRolle.userId, konto("kommandoJfA").id!));
    const programmId = await anlegen(tagPlus(13));
    const { kontakt } = await detail("elternJfA", programmId);
    expect(kontakt.abzeichen).toEqual({
      kuerzel: "R1",
      sterne: 1,
      bildUrl: null,
    });
    // Nie mehr vom Rang als das Abzeichen
    expect(JSON.stringify(kontakt)).not.toContain("Rang Eins");
    await db
      .update(schema.einheitRolle)
      .set({ rangId: null })
      .where(eq(schema.einheitRolle.userId, konto("kommandoJfA").id!));
    expect(
      (await detail("elternJfA", programmId)).kontakt.abzeichen,
    ).toBeNull();
  });

  test("GET /einheiten/:id/kontakt: Kommandant/in für alle, die die Einheit sehen; Nummer nur für Eltern", async () => {
    const pfad = (id: string) => `/api/v1/einheiten/${id}/kontakt`;
    const eltern = await senden("elternJfA", "GET", pfad(welt.einheit.jfA));
    expect(eltern.status).toBe(200);
    expect(await eltern.json()).toMatchObject({
      kontakt: {
        id: konto("kommandoJfA").id,
        rolle: "kommandant",
        telefon: "+41790000000",
      },
    });
    const leitung = await senden("leitendeJfA", "GET", pfad(welt.einheit.jfA));
    expect((await leitung.json()).kontakt.telefon).toBeNull();
    // Fremde Einheit: 404; Einheit ohne Kommando: kein Kontakt
    expect(
      (await senden("elternKfA", "GET", pfad(welt.einheit.jfA))).status,
    ).toBe(404);
    const ohne = await senden("elternKfA", "GET", pfad(welt.einheit.kfA));
    expect(await ohne.json()).toEqual({ kontakt: null });
    expect((await senden("elternJfA", "GET", pfad("kein-uuid"))).status).toBe(
      400,
    );
  });

  test("ein deaktiviertes Konto des Kommandos zählt wie «nein»", async () => {
    const eigene = await erstelleWelt(db, auth);
    const eltern = await legePersonaAn(eigene, "elternJfA");
    const kommando = await legePersonaAn(eigene, "kommandoJfA");
    const stv = await legePersonaAn(eigene, "stellvertretung1JfA");
    await db
      .update(schema.user)
      .set({ deaktiviertAm: new Date() })
      .where(eq(schema.user.id, kommando.id!));
    const antwort = await app.request(
      `/api/v1/einheiten/${eigene.einheit.jfA}/kontakt`,
      { headers: eltern.headers },
    );
    expect((await antwort.json()).kontakt.id).toBe(stv.id);
  });
});

describe("Rang-Abzeichen", () => {
  let reihenfolge = 10;
  const rang = async (werte: Partial<typeof schema.rang.$inferInsert>) =>
    (
      await db
        .insert(schema.rang)
        .values({
          einheitId: welt.einheit.jfA,
          name: "R",
          kuerzel: "R",
          reihenfolge: reihenfolge++,
          ...werte,
        })
        .returning({ id: schema.rang.id })
    )[0].id;
  const setzeRang = (rangId: string | null) =>
    db
      .update(schema.teilnehmende)
      .set({ rangId })
      .where(eq(schema.teilnehmende.id, welt.teilnehmende.jfA));
  let programmId: string;
  beforeAll(async () => {
    programmId = await anlegen(tagPlus(14));
  });
  const abzeichen = async () =>
    (await detail("elternJfA", programmId)).teilnehmende[0].abzeichen;

  test("Sterne, null Sterne und kein Rang", async () => {
    await setzeRang(await rang({ abzeichenSterne: 3 }));
    expect(await abzeichen()).toEqual({
      kuerzel: "R",
      sterne: 3,
      bildUrl: null,
    });
    await setzeRang(await rang({ abzeichenSterne: 0 }));
    expect(await abzeichen()).toEqual({
      kuerzel: "R",
      sterne: 0,
      bildUrl: null,
    });
    // Ein Rang ohne Sterne und Bild ist trotzdem ein Abzeichen: nur das Kürzel
    await setzeRang(await rang({}));
    expect(await abzeichen()).toEqual({
      kuerzel: "R",
      sterne: null,
      bildUrl: null,
    });
    await setzeRang(null);
    expect(await abzeichen()).toBeNull();
  });

  test("eigenes Bild: die Detail-Antwort nennt die Adresse, die Route liefert das Bild geschützt", async () => {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "#00aa00" },
    })
      .png()
      .toBuffer();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const pngId = await rang({ abzeichenBild: png, abzeichenBildTyp: "png" });
    const svgId = await rang({ abzeichenBild: svg, abzeichenBildTyp: "svg" });
    await setzeRang(pngId);
    expect(await abzeichen()).toEqual({
      kuerzel: "R",
      sterne: null,
      bildUrl: `/api/v1/raenge/${pngId}/abzeichen`,
    });

    const antwort = await senden(
      "elternJfA",
      "GET",
      `/api/v1/raenge/${pngId}/abzeichen`,
    );
    expect(antwort.status).toBe(200);
    expect(antwort.headers.get("content-type")).toBe("image/png");
    expect(antwort.headers.get("cache-control")).toBe("private, no-store");
    expect(antwort.headers.get("x-content-type-options")).toBe("nosniff");
    expect(antwort.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(Buffer.from(await antwort.arrayBuffer())).toEqual(png);

    const vektor = await senden(
      "kommandoJfA",
      "GET",
      `/api/v1/raenge/${svgId}/abzeichen`,
    );
    expect(vektor.headers.get("content-type")).toBe("image/svg+xml");

    // Fremde Einheit, Rang ohne Bild und unbekannter Rang: gleiche Antwort
    for (const [persona, id] of [
      ["elternKfA", pngId],
      ["elternJfA", await rang({ abzeichenSterne: 2 })],
      ["elternJfA", "0198a0e0-0000-7000-8000-000000000000"],
    ] as const) {
      const nein = await senden(
        persona,
        "GET",
        `/api/v1/raenge/${id}/abzeichen`,
      );
      expect(nein.status).toBe(404);
    }
  });
});
