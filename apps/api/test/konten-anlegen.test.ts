import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
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
let standard: Partial<Record<Persona, PersonaKonto>>;
const PERSONEN: Persona[] = [
  "kantonsadmin",
  "kommandoJfA",
  "stellvertretung1JfA",
  "leitendeJfA",
  "elternJfA",
  "elternKfA",
  "kommandoKfA",
];
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  standard = Object.fromEntries(
    await Promise.all(
      PERSONEN.map(async (p) => [p, await legePersonaAn(welt, p)]),
    ),
  );
});
const konto = (p: Persona) => standard[p]!;

const sende = (
  wer: PersonaKonto,
  methode: "GET" | "POST" | "PUT" | "DELETE",
  pfad: string,
  body?: unknown,
) =>
  app.request(pfad, {
    method: methode,
    headers: { ...wer.headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const einheitPfad = (teil: string, einheitId = welt.einheit.jfA) =>
  `/api/v1/admin/einheiten/${einheitId}/${teil}`;
// Eindeutige Namen: Alle Tests dieser Datei teilen die Datenbank
const name = (basis: string) => `${basis}.${randomUUID().slice(0, 8)}`;
const startpasswortForm =
  /^[23456789ACDEFGHJKMNPQRTUVWXY]{4}(-[23456789ACDEFGHJKMNPQRTUVWXY]{4}){2}$/;

async function benutzerMit(benutzername: string) {
  const [zeile] = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.username, benutzername.toLowerCase()));
  return zeile;
}

async function rollenVon(einheitId: string) {
  return db
    .select()
    .from(schema.einheitRolle)
    .where(eq(schema.einheitRolle.einheitId, einheitId))
    .orderBy(
      asc(schema.einheitRolle.typ),
      asc(schema.einheitRolle.reihenfolge),
    );
}

// Anmeldung wie die App, mit dem Startpasswort in der Anzeigeform
async function meldeAn(benutzername: string, startpasswort: string) {
  const antwort = await auth.api.signInUsername({
    body: { username: benutzername, password: startpasswort },
  });
  return antwort.user.id;
}

describe("Bezirk und Einheit mit Kommando", () => {
  test("der Kantonsadmin legt einen Bezirk an; derselbe Name ohne Gross-/Kleinschreibung ist 409", async () => {
    const bezirkName = name("Bezirk Neu");
    const neu = await sende(
      konto("kantonsadmin"),
      "POST",
      "/api/v1/admin/bezirke",
      { name: bezirkName },
    );
    expect(neu.status).toBe(201);
    const { id } = await neu.json();
    const doppelt = await sende(
      konto("kantonsadmin"),
      "POST",
      "/api/v1/admin/bezirke",
      { name: bezirkName.toUpperCase() },
    );
    expect(doppelt.status).toBe(409);
    expect(await doppelt.json()).toMatchObject({ code: "BEZIRK_VORHANDEN" });
    const liste = await (
      await sende(konto("kantonsadmin"), "GET", "/api/v1/admin/bezirke")
    ).json();
    expect(liste.bezirke).toContainEqual({ id, name: bezirkName });
    const protokoll = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.zielId, id));
    expect(protokoll).toMatchObject([
      {
        akteurId: konto("kantonsadmin").id,
        aktion: "bezirk_angelegt",
        einheitId: null,
      },
    ]);
  });

  async function neuerBezirk() {
    const [zeile] = await db
      .insert(schema.bezirk)
      .values({ name: name("Bezirk") })
      .returning({ id: schema.bezirk.id });
    return zeile.id;
  }

  test("Einheit und Kommandant/in entstehen in einer Transaktion; das Startpasswort gilt für die erste Anmeldung", async () => {
    const bezirkId = await neuerBezirk();
    const benutzername = name("kdt");
    const antwort = await sende(
      konto("kantonsadmin"),
      "POST",
      "/api/v1/admin/einheiten",
      {
        bezirkId,
        typ: "kf",
        name: "KF Neu",
        kommandant: {
          vorname: "Kim",
          nachname: "Kommando",
          benutzername,
          telefon: "+41 79 123 45 67",
        },
      },
    );
    expect(antwort.status).toBe(201);
    const { id, kommandant } = await antwort.json();
    expect(kommandant.benutzername).toBe(benutzername);
    expect(kommandant.startpasswort).toMatch(startpasswortForm);

    const [zeile] = await db
      .select()
      .from(schema.einheit)
      .where(eq(schema.einheit.id, id));
    expect(zeile).toMatchObject({ bezirkId, typ: "kf", name: "KF Neu" });
    expect(await rollenVon(id)).toMatchObject([
      { userId: kommandant.id, typ: "kommandant" },
    ]);
    const benutzer = await benutzerMit(benutzername);
    expect(benutzer).toMatchObject({
      id: kommandant.id,
      name: "Kim Kommando",
      role: "user",
      telefon: "+41 79 123 45 67",
      mussPasswortAendern: true,
    });
    // Das Startpasswort steht nur verschlüsselt in der Datenbank, nie im Klartext
    expect(benutzer.startpasswortVerschluesselt).not.toContain(
      kommandant.startpasswort,
    );
    expect(await meldeAn(benutzername, kommandant.startpasswort)).toBe(
      kommandant.id,
    );
    const aktionen = await db
      .select({
        aktion: schema.auditLog.aktion,
        einheitId: schema.auditLog.einheitId,
      })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.einheitId, id));
    expect(aktionen.map((a) => a.aktion).sort()).toEqual([
      "einheit_angelegt",
      "person_angelegt",
    ]);
  });

  test("dieselbe Art im selben Bezirk ist 409 und legt kein Konto an", async () => {
    const bezirkId = await neuerBezirk();
    const body = (benutzername: string) => ({
      bezirkId,
      typ: "jf",
      name: "JF",
      kommandant: { vorname: "A", nachname: "B", benutzername },
    });
    const erste = name("erste");
    expect(
      (
        await sende(
          konto("kantonsadmin"),
          "POST",
          "/api/v1/admin/einheiten",
          body(erste),
        )
      ).status,
    ).toBe(201);
    const zweite = name("zweite");
    const doppelt = await sende(
      konto("kantonsadmin"),
      "POST",
      "/api/v1/admin/einheiten",
      body(zweite),
    );
    expect(doppelt.status).toBe(409);
    expect(await doppelt.json()).toMatchObject({ code: "EINHEIT_VORHANDEN" });
    expect(await benutzerMit(zweite)).toBeUndefined();
  });

  test("ein vergebener Benutzername ist 409 und legt keine Einheit an; ein unbekannter Bezirk ist 400", async () => {
    const bezirkId = await neuerBezirk();
    const antwort = await sende(
      konto("kantonsadmin"),
      "POST",
      "/api/v1/admin/einheiten",
      {
        bezirkId,
        typ: "jf",
        name: "JF",
        // Gross-/Kleinschreibung zählt nicht
        kommandant: {
          vorname: "A",
          nachname: "B",
          benutzername: konto("elternJfA").benutzername!.toUpperCase(),
        },
      },
    );
    expect(antwort.status).toBe(409);
    expect(await antwort.json()).toMatchObject({
      code: "BENUTZERNAME_VERGEBEN",
    });
    expect(
      await db
        .select()
        .from(schema.einheit)
        .where(eq(schema.einheit.bezirkId, bezirkId)),
    ).toEqual([]);

    const unbekannt = await sende(
      konto("kantonsadmin"),
      "POST",
      "/api/v1/admin/einheiten",
      {
        bezirkId: randomUUID(),
        typ: "jf",
        name: "JF",
        kommandant: { vorname: "A", nachname: "B", benutzername: name("x") },
      },
    );
    expect(unbekannt.status).toBe(400);
  });

  test("Kommando, Stellvertretung und Eltern dürfen weder Bezirke noch Einheiten anlegen", async () => {
    for (const persona of [
      "kommandoJfA",
      "stellvertretung1JfA",
      "elternJfA",
    ] as const) {
      const bezirk = await sende(
        konto(persona),
        "POST",
        "/api/v1/admin/bezirke",
        { name: name("Nein") },
      );
      expect(bezirk.status, persona).toBe(403);
      const einheit = await sende(
        konto(persona),
        "POST",
        "/api/v1/admin/einheiten",
        {
          bezirkId: welt.bezirkAId,
          typ: "kf",
          name: "Nein",
          kommandant: { vorname: "A", nachname: "B", benutzername: name("n") },
        },
      );
      expect(einheit.status, persona).toBe(403);
    }
  });

  test("die Liste der Einheiten zeigt dem Kommando nur die eigene", async () => {
    const liste = await (
      await sende(konto("kommandoJfA"), "GET", "/api/v1/admin/einheiten")
    ).json();
    expect(liste.einheiten.map((e: { id: string }) => e.id)).toEqual([
      welt.einheit.jfA,
    ]);
    const alle = await (
      await sende(konto("kantonsadmin"), "GET", "/api/v1/admin/einheiten")
    ).json();
    expect(alle.einheiten.map((e: { id: string }) => e.id)).toEqual(
      expect.arrayContaining(Object.values(welt.einheit)),
    );
  });
});

describe("Stellvertretungen", () => {
  const stvPfad = (einheitId = welt.einheit.jfA) =>
    einheitPfad("stellvertretungen", einheitId);
  const neueStv = (extra: object = {}) => ({
    vorname: "Sven",
    nachname: "Stellvertretung",
    benutzername: name("stv"),
    ...extra,
  });

  test("das Kommando legt Stellvertretungen mit Reihenfolge an; ohne Angabe kommt die neue ans Ende", async () => {
    const eigene = konto("kommandoJfA");
    // stellvertretung1JfA aus der Welt steht an Position 1
    const zwei = await sende(
      eigene,
      "POST",
      stvPfad(),
      neueStv({ telefon: "079 111 22 33" }),
    );
    expect(zwei.status).toBe(201);
    const daten = await zwei.json();
    expect(daten.reihenfolge).toBe(2);
    expect(daten.startpasswort).toMatch(startpasswortForm);
    expect(await benutzerMit(daten.benutzername)).toMatchObject({
      telefon: "079 111 22 33",
      mussPasswortAendern: true,
    });
    expect(await meldeAn(daten.benutzername, daten.startpasswort)).toBe(
      daten.id,
    );

    const belegt = await sende(
      eigene,
      "POST",
      stvPfad(),
      neueStv({ reihenfolge: 2 }),
    );
    expect(belegt.status).toBe(409);
    expect(await belegt.json()).toMatchObject({ code: "REIHENFOLGE_BELEGT" });

    const eigenePosition = await sende(
      eigene,
      "POST",
      stvPfad(),
      neueStv({ reihenfolge: 8 }),
    );
    expect(eigenePosition.status).toBe(201);
    expect((await eigenePosition.json()).reihenfolge).toBe(8);
    const ohne = await sende(eigene, "POST", stvPfad(), neueStv());
    expect((await ohne.json()).reihenfolge).toBe(9);
  });

  test("ordnen verschiebt eine Stellvertretung; die übrigen rücken nach und zählen wieder ab 1", async () => {
    const eigene = konto("kommandoJfA");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const antwort = await sende(
        eigene,
        "POST",
        stvPfad(),
        neueStv({ reihenfolge: 40 + i }),
      );
      ids.push((await antwort.json()).id);
    }
    const [a, b, c] = ids;
    const reihenfolge = async () =>
      (
        await db
          .select({ userId: schema.einheitRolle.userId })
          .from(schema.einheitRolle)
          .where(
            and(
              eq(schema.einheitRolle.einheitId, welt.einheit.jfA),
              eq(schema.einheitRolle.typ, "stellvertretung"),
              inArray(schema.einheitRolle.userId, ids),
            ),
          )
          .orderBy(asc(schema.einheitRolle.reihenfolge))
      ).map((z) => z.userId);
    expect(await reihenfolge()).toEqual([a, b, c]);
    const nachVorn = await sende(eigene, "PUT", `${stvPfad()}/${c}`, {
      reihenfolge: 1,
    });
    expect(nachVorn.status).toBe(204);
    expect(await reihenfolge()).toEqual([c, a, b]);
    const zeilen = await rollenVon(welt.einheit.jfA);
    const positionen = zeilen
      .filter((z) => z.typ === "stellvertretung")
      .map((z) => z.reihenfolge);
    expect(positionen).toEqual(positionen.map((_, i) => i + 1));
    // Eine zu grosse Zahl heisst: ans Ende
    expect(
      (await sende(eigene, "PUT", `${stvPfad()}/${c}`, { reihenfolge: 99 }))
        .status,
    ).toBe(204);
    expect(await reihenfolge()).toEqual([a, b, c]);
  });

  test("entfernen nimmt die Rolle, das Konto bleibt; ein Unbekannter ist 404", async () => {
    const eigene = konto("kommandoJfA");
    const neu = await (
      await sende(eigene, "POST", stvPfad(), neueStv())
    ).json();
    const weg = await sende(eigene, "DELETE", `${stvPfad()}/${neu.id}`);
    expect(weg.status).toBe(204);
    expect(
      (await rollenVon(welt.einheit.jfA)).some((r) => r.userId === neu.id),
    ).toBe(false);
    expect(await benutzerMit(neu.benutzername)).toBeDefined();
    expect(
      (await sende(eigene, "DELETE", `${stvPfad()}/${neu.id}`)).status,
    ).toBe(404);
    // Ein Leitender ist keine Stellvertretung
    const leitende = konto("leitendeJfA").id!;
    expect(
      (await sende(eigene, "DELETE", `${stvPfad()}/${leitende}`)).status,
    ).toBe(404);
  });

  test("eine Stellvertretung darf keine anlegen, ordnen oder entfernen: 403; das Kommando einer fremden Einheit 404", async () => {
    const stv = konto("stellvertretung1JfA");
    const eigene = konto("kommandoJfA");
    const ziel = await (
      await sende(eigene, "POST", stvPfad(), neueStv())
    ).json();
    expect((await sende(stv, "POST", stvPfad(), neueStv())).status).toBe(403);
    expect(
      (await sende(stv, "PUT", `${stvPfad()}/${ziel.id}`, { reihenfolge: 1 }))
        .status,
    ).toBe(403);
    expect((await sende(stv, "DELETE", `${stvPfad()}/${ziel.id}`)).status).toBe(
      403,
    );
    // Die Stellvertretung selbst bleibt unberührt
    expect(await rollenVon(welt.einheit.jfA)).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: ziel.id })]),
    );
    const fremd = konto("kommandoKfA");
    expect((await sende(fremd, "POST", stvPfad(), neueStv())).status).toBe(404);
    expect(
      (await sende(fremd, "DELETE", `${stvPfad()}/${ziel.id}`)).status,
    ).toBe(404);
  });

  test("ein fehlgeschlagenes Anlegen hinterlässt weder Konto noch Rolle (Benutzername vergeben)", async () => {
    const eigene = konto("kommandoJfA");
    const vorher = (await rollenVon(welt.einheit.jfA)).length;
    const antwort = await sende(
      eigene,
      "POST",
      stvPfad(),
      neueStv({ benutzername: konto("elternJfA").benutzername }),
    );
    expect(antwort.status).toBe(409);
    expect(await antwort.json()).toMatchObject({
      code: "BENUTZERNAME_VERGEBEN",
    });
    expect((await rollenVon(welt.einheit.jfA)).length).toBe(vorher);
  });
});

describe("Leitende", () => {
  test("Kommando und Stellvertretung legen Leitende an, Leitende und Eltern nicht", async () => {
    const pfad = einheitPfad("leitende");
    const body = () => ({
      vorname: "Lea",
      nachname: "Leitung",
      benutzername: name("leitung"),
    });
    const vomKommando = await sende(konto("kommandoJfA"), "POST", pfad, body());
    expect(vomKommando.status).toBe(201);
    const neu = await vomKommando.json();
    expect(neu.startpasswort).toMatch(startpasswortForm);
    expect(
      (await rollenVon(welt.einheit.jfA)).find((r) => r.userId === neu.id),
    ).toMatchObject({
      typ: "leitung",
      reihenfolge: null,
    });
    // Eine Nummer gehört nur Kommando und Stellvertretungen: Das Feld gibt es hier nicht
    expect(
      (
        await sende(konto("kommandoJfA"), "POST", pfad, {
          ...body(),
          telefon: "079 111 22 33",
        })
      ).status,
    ).toBe(400);
    expect(
      (await sende(konto("stellvertretung1JfA"), "POST", pfad, body())).status,
    ).toBe(201);
    expect(
      (await sende(konto("leitendeJfA"), "POST", pfad, body())).status,
    ).toBe(403);
    expect((await sende(konto("elternJfA"), "POST", pfad, body())).status).toBe(
      403,
    );
    expect(
      (await sende(konto("kommandoKfA"), "POST", pfad, body())).status,
    ).toBe(404);
  });
});

describe("Teilnehmende und Eltern", () => {
  const pfad = () => einheitPfad("teilnehmende");
  const eltern = (extra: object = {}) => ({
    vorname: "Erika",
    nachname: "Eltern",
    benutzername: name("eltern"),
    ...extra,
  });

  async function verknuepfungen(teilnehmendeId: string) {
    return db
      .select({
        userId: schema.teilnehmendeKonto.userId,
        art: schema.teilnehmendeKonto.art,
      })
      .from(schema.teilnehmendeKonto)
      .where(eq(schema.teilnehmendeKonto.teilnehmendeId, teilnehmendeId));
  }

  test("das Kommando legt fest: Eltern antworten, mit einem neuen und einem bestehenden Konto", async () => {
    const neuesElternteil = eltern();
    const antwort = await sende(konto("kommandoJfA"), "POST", pfad(), {
      vorname: "Tim",
      nachname: "Teilnehmer",
      rangId: welt.rangId,
      antwort: {
        art: "eltern",
        eltern: [
          neuesElternteil,
          { bestehendesKonto: konto("elternJfA").benutzername },
        ],
      },
    });
    expect(antwort.status).toBe(201);
    const { id, konten } = await antwort.json();
    expect(konten).toHaveLength(2);
    expect(konten[0]).toMatchObject({
      benutzername: neuesElternteil.benutzername,
      art: "eltern",
    });
    expect(konten[0].startpasswort).toMatch(startpasswortForm);
    // Ein bestehendes Konto behält sein Passwort und bekommt kein neues
    expect(konten[1]).toMatchObject({
      userId: konto("elternJfA").id,
      art: "eltern",
    });
    expect(konten[1].startpasswort).toBeUndefined();
    expect(await verknuepfungen(id)).toHaveLength(2);
    const [person] = await db
      .select()
      .from(schema.teilnehmende)
      .where(eq(schema.teilnehmende.id, id));
    expect(person).toMatchObject({
      einheitId: welt.einheit.jfA,
      rangId: welt.rangId,
      inaktivSeit: null,
    });
  });

  test("oder die Person antwortet selbst: ein Konto mit ihrem Namen", async () => {
    const benutzername = name("selbst");
    const antwort = await sende(konto("kommandoJfA"), "POST", pfad(), {
      vorname: "Sina",
      nachname: "Selbst",
      antwort: { art: "selbst", benutzername },
    });
    expect(antwort.status).toBe(201);
    const { id, konten } = await antwort.json();
    expect(konten).toHaveLength(1);
    expect(konten[0]).toMatchObject({ benutzername, art: "selbst" });
    expect(await benutzerMit(benutzername)).toMatchObject({
      name: "Sina Selbst",
    });
    expect(await verknuepfungen(id)).toEqual([
      { userId: konten[0].userId, art: "selbst" },
    ]);
    expect(await meldeAn(benutzername, konten[0].startpasswort)).toBe(
      konten[0].userId,
    );
  });

  test("eine Person antwortet nie über Eltern und selbst zugleich", async () => {
    // Selbst: Eltern kommen nicht dazu
    const selbst = await (
      await sende(konto("kommandoJfA"), "POST", pfad(), {
        vorname: "Sam",
        nachname: "Selbst",
        antwort: { art: "selbst", benutzername: name("selbst") },
      })
    ).json();
    const elternDazu = await sende(
      konto("kommandoJfA"),
      "POST",
      `${pfad()}/${selbst.id}/eltern`,
      { eltern: eltern() },
    );
    expect(elternDazu.status).toBe(409);
    expect(await elternDazu.json()).toMatchObject({ code: "SELBST_ANTWORTET" });
    // Eltern: ein eigenes Konto geht nur über den Konto-Wechsel (das Konto des Kindes bleibt aus)
    const mitEltern = await (
      await sende(konto("kommandoJfA"), "POST", pfad(), {
        vorname: "Ela",
        nachname: "Eltern",
        antwort: { art: "eltern", eltern: [eltern()] },
      })
    ).json();
    const zweitesElternteil = await sende(
      konto("kommandoJfA"),
      "POST",
      `${pfad()}/${mitEltern.id}/eltern`,
      { eltern: eltern() },
    );
    expect(zweitesElternteil.status).toBe(201);
    // Dasselbe Konto zweimal
    const nochmal = await sende(
      konto("kommandoJfA"),
      "POST",
      `${pfad()}/${mitEltern.id}/eltern`,
      { eltern: { bestehendesKonto: mitEltern.konten[0].benutzername } },
    );
    expect(nochmal.status).toBe(409);
    expect(await nochmal.json()).toMatchObject({ code: "SCHON_VERKNUEPFT" });
    expect(await verknuepfungen(mitEltern.id)).toHaveLength(2);
  });

  test("ein bestehendes Konto muss aktiv sein und darf weder dem Kantonsadmin gehören noch selbst für eine Person antworten: 400", async () => {
    const selbstKonto = await (
      await sende(konto("kommandoJfA"), "POST", pfad(), {
        vorname: "Sepp",
        nachname: "Selbst",
        antwort: { art: "selbst", benutzername: name("selbst") },
      })
    ).json();
    for (const bestehend of [
      "gibt.es.nicht",
      konto("kantonsadmin").benutzername!,
      selbstKonto.konten[0].benutzername,
    ]) {
      const antwort = await sende(konto("kommandoJfA"), "POST", pfad(), {
        vorname: "Max",
        nachname: "Muster",
        antwort: { art: "eltern", eltern: [{ bestehendesKonto: bestehend }] },
      });
      expect(antwort.status, bestehend).toBe(400);
    }
  });

  test("scheitert ein Konto, bleibt auch die Person aus (eine Transaktion)", async () => {
    const vorher = await db
      .select({ id: schema.teilnehmende.id })
      .from(schema.teilnehmende)
      .where(eq(schema.teilnehmende.einheitId, welt.einheit.jfA));
    const antwort = await sende(konto("kommandoJfA"), "POST", pfad(), {
      vorname: "Nie",
      nachname: "Angelegt",
      antwort: {
        art: "eltern",
        eltern: [
          eltern(),
          eltern({ benutzername: konto("elternJfA").benutzername }),
        ],
      },
    });
    expect(antwort.status).toBe(409);
    const nachher = await db
      .select({ id: schema.teilnehmende.id })
      .from(schema.teilnehmende)
      .where(eq(schema.teilnehmende.einheitId, welt.einheit.jfA));
    expect(nachher).toHaveLength(vorher.length);
  });

  test("ein Rang einer anderen Einheit ist 400; Rechte: Leitende und Eltern 403, fremdes Kommando 404", async () => {
    const [fremderRang] = await db
      .insert(schema.rang)
      .values({
        einheitId: welt.einheit.kfA,
        name: "Fremd",
        kuerzel: "F",
        reihenfolge: 1,
      })
      .returning({ id: schema.rang.id });
    const body = (extra: object = {}) => ({
      vorname: "Rea",
      nachname: "Rang",
      antwort: { art: "eltern", eltern: [] },
      ...extra,
    });
    expect(
      (
        await sende(
          konto("kommandoJfA"),
          "POST",
          pfad(),
          body({ rangId: fremderRang.id }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await sende(konto("leitendeJfA"), "POST", pfad(), body())).status,
    ).toBe(403);
    expect(
      (await sende(konto("elternJfA"), "POST", pfad(), body())).status,
    ).toBe(403);
    expect(
      (await sende(konto("kommandoKfA"), "POST", pfad(), body())).status,
    ).toBe(404);
    // Die Einheit kommt aus der URL, nie aus dem Body
    expect(
      (
        await sende(
          konto("kommandoJfA"),
          "POST",
          pfad(),
          body({ einheitId: welt.einheit.kfA }),
        )
      ).status,
    ).toBe(400);
  });

  test("Eltern einer anderen Einheit lassen sich nicht an eine Person dieser Einheit hängen: 404", async () => {
    const fremd = einheitPfad("teilnehmende", welt.einheit.kfA);
    const antwort = await sende(
      konto("kommandoJfA"),
      "POST",
      `${fremd}/${welt.teilnehmende.kfA}/eltern`,
      { eltern: eltern() },
    );
    expect(antwort.status).toBe(404);
    // Person der eigenen Einheit, aber in der URL einer anderen: ebenfalls 404
    const kreuz = await sende(
      konto("kommandoKfA"),
      "POST",
      `${fremd}/${welt.teilnehmende.jfA}/eltern`,
      { eltern: eltern() },
    );
    expect(kreuz.status).toBe(404);
  });
});

describe("Konto-Wechsel Eltern → Kind", () => {
  async function personMitEltern() {
    // Die Eltern sind das Konto einer Persona mit Sitzung: So lässt sich der Zugriff vor und nach dem Wechsel prüfen
    const eltern = await legePersonaAn(welt, "elternJfA");
    const antwort = await sende(
      konto("kommandoJfA"),
      "POST",
      einheitPfad("teilnehmende"),
      {
        vorname: "Wechsel",
        nachname: name("Kind"),
        antwort: {
          art: "eltern",
          eltern: [{ bestehendesKonto: eltern.benutzername }],
        },
      },
    );
    expect(antwort.status).toBe(201);
    return { eltern, id: (await antwort.json()).id as string };
  }

  const teilnahme = (wer: PersonaKonto, programmId: string, id: string) =>
    sende(wer, "PUT", `/api/v1/programme/${programmId}/teilnahmen/${id}`, {
      status: "ja",
    });

  test("das Kind bekommt ein Konto mit Startpasswort, die Eltern verlieren es (404), andere Kinder der Eltern bleiben", async () => {
    const { eltern, id } = await personMitEltern();
    const geschwister = (
      await (
        await sende(konto("kommandoJfA"), "POST", einheitPfad("teilnehmende"), {
          vorname: "Bleibt",
          nachname: name("Kind"),
          antwort: {
            art: "eltern",
            eltern: [{ bestehendesKonto: eltern.benutzername }],
          },
        })
      ).json()
    ).id as string;
    const programm = await legeProgrammAn(db, {
      einheitId: welt.einheit.jfA,
      beginn: new Date(Date.now() + 10 * 86_400_000),
    });
    expect((await teilnahme(eltern, programm.id, id)).status).toBe(204);

    const benutzername = name("kind");
    const vorher = Date.now();
    const wechsel = await sende(
      konto("kommandoJfA"),
      "POST",
      `${einheitPfad("teilnehmende")}/${id}/konto-wechsel`,
      { benutzername },
    );
    expect(wechsel.status).toBe(201);
    const kind = await wechsel.json();
    expect(kind).toMatchObject({ benutzername, art: "selbst" });
    expect(kind.startpasswort).toMatch(startpasswortForm);

    // Das Kind setzt beim ersten Login ein eigenes Passwort: Pflichtwechsel an, 7 Tage gültig
    const konto2 = await benutzerMit(benutzername);
    expect(konto2.mussPasswortAendern).toBe(true);
    expect(konto2.startpasswortGueltigBis!.getTime()).toBeGreaterThanOrEqual(
      vorher + 7 * 86_400_000,
    );
    expect(await meldeAn(benutzername, kind.startpasswort)).toBe(kind.userId);

    expect(await verknuepfungen2(id)).toEqual([
      { userId: kind.userId, art: "selbst" },
    ]);
    // Für die früheren Eltern gibt es die Person nicht mehr; das Geschwister bleibt
    expect((await teilnahme(eltern, programm.id, id)).status).toBe(404);
    expect((await teilnahme(eltern, programm.id, geschwister)).status).toBe(
      204,
    );
    const profil = await (await sende(eltern, "GET", "/api/v1/ich")).json();
    const ids = profil.teilnehmende.map((t: { id: string }) => t.id);
    expect(ids).toContain(geschwister);
    expect(ids).not.toContain(id);

    const protokoll = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.zielId, id),
          eq(schema.auditLog.aktion, "konto_gewechselt"),
        ),
      );
    expect(protokoll).toMatchObject([
      {
        akteurId: konto("kommandoJfA").id,
        details: { entfernteEltern: 1, neuesKonto: kind.userId },
      },
    ]);
  });

  async function verknuepfungen2(id: string) {
    return db
      .select({
        userId: schema.teilnehmendeKonto.userId,
        art: schema.teilnehmendeKonto.art,
      })
      .from(schema.teilnehmendeKonto)
      .where(eq(schema.teilnehmendeKonto.teilnehmendeId, id));
  }

  test("scheitert das neue Konto (Benutzername vergeben), bleiben die Eltern verknüpft", async () => {
    const { eltern, id } = await personMitEltern();
    const antwort = await sende(
      konto("kommandoJfA"),
      "POST",
      `${einheitPfad("teilnehmende")}/${id}/konto-wechsel`,
      { benutzername: eltern.benutzername },
    );
    expect(antwort.status).toBe(409);
    expect(await antwort.json()).toMatchObject({
      code: "BENUTZERNAME_VERGEBEN",
    });
    expect(await verknuepfungen2(id)).toEqual([
      { userId: eltern.id, art: "eltern" },
    ]);
  });

  test("ein zweiter Wechsel ist 409 EIGENES_KONTO_VORHANDEN; Eltern kommen danach nicht mehr dazu", async () => {
    const { id } = await personMitEltern();
    const pfad = `${einheitPfad("teilnehmende")}/${id}/konto-wechsel`;
    expect(
      (
        await sende(konto("kommandoJfA"), "POST", pfad, {
          benutzername: name("k"),
        })
      ).status,
    ).toBe(201);
    const nochmal = await sende(konto("kommandoJfA"), "POST", pfad, {
      benutzername: name("k"),
    });
    expect(nochmal.status).toBe(409);
    expect(await nochmal.json()).toMatchObject({
      code: "EIGENES_KONTO_VORHANDEN",
    });
    expect(await verknuepfungen2(id)).toHaveLength(1);
  });

  test("Stellvertretung darf wechseln, Leitende und Eltern nicht; eine Person einer anderen Einheit ist 404", async () => {
    const { id } = await personMitEltern();
    const pfad = `${einheitPfad("teilnehmende")}/${id}/konto-wechsel`;
    const body = () => ({ benutzername: name("k") });
    expect(
      (await sende(konto("leitendeJfA"), "POST", pfad, body())).status,
    ).toBe(403);
    expect((await sende(konto("elternKfA"), "POST", pfad, body())).status).toBe(
      404,
    );
    expect(
      (await sende(konto("kommandoKfA"), "POST", pfad, body())).status,
    ).toBe(404);
    expect(
      (await sende(konto("stellvertretung1JfA"), "POST", pfad, body())).status,
    ).toBe(201);
    const fremd = `${einheitPfad("teilnehmende", welt.einheit.kfA)}/${id}/konto-wechsel`;
    expect(
      (await sende(konto("kommandoKfA"), "POST", fremd, body())).status,
    ).toBe(404);
  });
});
