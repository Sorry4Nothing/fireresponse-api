import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
import { kodiereProfilbild } from "../src/bild-sharp.js";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { ladeSeiten } from "../src/seiten.js";
import {
  bereiteAuthTestsVor,
  erstelleTestAuth,
  geschlossenePfade,
  PASSWORT,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  PERSONAS,
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
  kodiereBild: kodiereProfilbild,
  // Eine Attrappe statt firebase-admin: Kein Test der Matrix soll ins Netz gehen
  fcm: {
    sendEach: async (nachrichten) => ({
      responses: nachrichten.map(() => ({ success: true })),
    }),
  },
  seiten: ladeSeiten(),
});
afterAll(() => sql.end());

const FALSCH = "nur-fuer-tests-falsch";

interface Zeile {
  // Literale Werte: beobachtet und gegen better-auth gegengelesen, nie aus rechte.ts berechnet
  erwartet: Record<Persona, number>;
  body?: (konto: PersonaKonto) => Record<string, unknown>;
  // Statt body: Der Body ist das Bild selbst (Profilbild-Upload)
  bild?: true;
  // Für Zeilen, die die Sitzungen der geteilten Personas beenden oder ihre Daten ändern würden: eigene Personas in einer eigenen Welt
  frischePersonas?: true;
  // Pflicht für jede Route mit Pfad-Parameter: ein Objekt der Welt
  url?: (welt: Welt) => string;
  // Statt url, wenn jede Anfrage ihr Ziel verbraucht (DELETE): eine frische URL pro Persona
  urlJeAnfrage?: () => Promise<string>;
}

const alle = (status: number) =>
  Object.fromEntries(PERSONAS.map((p) => [p, status])) as Record<
    Persona,
    number
  >;

// Die Standardsperren jeder Route unter /api/v1 ausser den Ausnahmen: ohne Sitzung und deaktiviert 401, Pflichtwechsel und fehlende Einwilligung 403
const SPERREN = {
  mussPasswortAendern: 403,
  ohneEinwilligung: 403,
  deaktiviert: 401,
  ohneLogin: 401,
} as const;

// Alle, die ein Programm von JF A sehen (Kommando, Leitende, Eltern, Teilnehmende, Kantonsadmin), und die, die es nicht sehen (404)
const SEHEN_JF_A = {
  kantonsadmin: 200,
  kantonsadminOhneZweitenFaktor: 200,
  kommandoJfA: 200,
  stellvertretung1JfA: 200,
  stellvertretung2JfA: 200,
  leitendeJfA: 200,
  leitendeJfAElternKfA: 200,
  elternJfA: 200,
  elternAundB: 200,
  teilnehmendeSelbstJfA: 200,
  elternNachWechsel: 200,
  kommandoKfBOhneZweitenFaktor: 404,
  kommandoKfA: 404,
  kommandoJfB: 404,
  elternKfA: 404,
} as const;

// Ein Satz für die Routen der Verwaltung einer Einheit (JF A): Kantonsadmin, Kommandant und Stellvertretungen dürfen. Ohne zweiten Faktor sperrt die Middleware jedes Konto mit Verwaltungsrolle (403, auch das Kommando in der App); Leitende und Eltern der Einheit sehen sie, dürfen aber nichts (403); wer die Einheit nicht sieht, bekommt 404
const VERWALTEN_JF_A = (erlaubt: number) =>
  ({
    ...alle(403),
    kantonsadmin: erlaubt,
    kommandoJfA: erlaubt,
    stellvertretung1JfA: erlaubt,
    stellvertretung2JfA: erlaubt,
    kommandoKfA: 404,
    kommandoJfB: 404,
    elternKfA: 404,
    deaktiviert: 401,
    ohneLogin: 401,
  }) as Record<Persona, number>;

// Auswertung ohne Objekt in der URL: Wer eine Einheit verwaltet (Kantonsadmin, Kommandant, Stellvertretung) bekommt die Zahlen der eigenen Einheiten, auch das Kommando von KF A und JF B; Leitende und Eltern 403. Die Zahlen jeder Einheit prüft test/auswertung.test.ts
const AUSWERTEN = {
  ...alle(403),
  kantonsadmin: 200,
  kommandoJfA: 200,
  stellvertretung1JfA: 200,
  stellvertretung2JfA: 200,
  kommandoKfA: 200,
  kommandoJfB: 200,
  deaktiviert: 401,
  ohneLogin: 401,
} as Record<Persona, number>;
const JAHR_2025 = "von=2025-01-01&bis=2025-12-31";

const MATRIX: Record<string, Zeile> = {
  "GET /health": { erwartet: alle(200) },
  // Statische Seiten und .well-known: offen für alle, auch deaktiviert und ohne Login
  "GET /datenschutz": { erwartet: alle(200) },
  "GET /konto-loeschen": { erwartet: alle(200) },
  "GET /support": { erwartet: alle(200) },
  // Verwaltung im Browser (#141): statische Dateien, die Daten kommen erst über die abgesicherten Admin-Routen
  "GET /admin": { erwartet: alle(200) },
  "GET /admin/admin.css": { erwartet: alle(200) },
  "GET /admin/admin.js": { erwartet: alle(200) },
  "GET /admin/api.js": { erwartet: alle(200) },
  "GET /admin/dom.js": { erwartet: alle(200) },
  "GET /admin/favicon.svg": { erwartet: alle(200) },
  "GET /admin/hintergrund.svg": { erwartet: alle(200) },
  "GET /admin/system.js": { erwartet: alle(200) },
  "GET /admin/uebersicht.js": { erwartet: alle(200) },
  "GET /.well-known/apple-app-site-association": { erwartet: alle(200) },
  "GET /.well-known/assetlinks.json": { erwartet: alle(200) },
  "POST /api/auth/sign-in/username": {
    // Eigene Zugangsdaten; ohneLogin mit erfundenem Namen. Deaktiviert und unbekannt bekommen dieselbe 401-Meldung (#15)
    body: (konto) => ({
      username: konto.benutzername ?? "gibt.es.nicht",
      password: konto.passwort ?? PASSWORT,
    }),
    erwartet: { ...alle(200), deaktiviert: 401, ohneLogin: 401 },
  },
  "POST /api/auth/sign-out": {
    // Auch ohne oder mit abgelaufener Sitzung 200: better-auth räumt nur das Cookie weg
    frischePersonas: true,
    erwartet: alle(200),
  },
  "GET /api/auth/get-session": { erwartet: alle(200) },
  "POST /api/auth/change-password": {
    // Falsches Passwort: better-auth prüft es, bevor es etwas schreibt
    body: () => ({
      currentPassword: FALSCH,
      newPassword: "nur-fuer-tests-neu-1",
    }),
    erwartet: { ...alle(400), deaktiviert: 401, ohneLogin: 401 },
  },
  "POST /api/auth/revoke-sessions": {
    frischePersonas: true,
    erwartet: { ...alle(200), deaktiviert: 401, ohneLogin: 401 },
  },
  // Wer den zweiten Faktor eingerichtet hat, bekommt bei falschem Code 401, alle anderen 400
  "POST /api/auth/two-factor/verify-totp": {
    body: () => ({ code: "000000" }),
    erwartet: {
      ...alle(400),
      kantonsadmin: 401,
      kommandoJfA: 401,
      stellvertretung1JfA: 401,
      stellvertretung2JfA: 401,
      kommandoKfA: 401,
      kommandoJfB: 401,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "POST /api/auth/two-factor/verify-backup-code": {
    body: () => ({ code: "falsch-falsch" }),
    erwartet: {
      ...alle(400),
      kantonsadmin: 401,
      kommandoJfA: 401,
      stellvertretung1JfA: 401,
      stellvertretung2JfA: 401,
      kommandoKfA: 401,
      kommandoJfB: 401,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  // Einrichten dürfen heute nur Kantonsadmins; das Kommando bekommt den Zugang mit E2 (#16)
  "POST /api/auth/two-factor/enable": {
    body: () => ({ password: FALSCH }),
    erwartet: {
      ...alle(404),
      kantonsadmin: 400,
      kantonsadminOhneZweitenFaktor: 400,
    },
  },
  // Die Felder je Rolle prüft test/ich.test.ts; GET /ich bleibt neben der Einwilligung die einzige /api/v1-Route, die auch unter dem Pflichtwechsel und ohne Einwilligung offen ist
  "GET /api/v1/ich": {
    erwartet: { ...alle(200), deaktiviert: 401, ohneLogin: 401 },
  },
  "PATCH /api/v1/ich": {
    // Schreibt push_anmeldungen, darum eigene Personas; die Felder prüft test/ich.test.ts
    frischePersonas: true,
    body: () => ({ pushAnmeldungen: false }),
    erwartet: { ...alle(204), ...SPERREN },
  },
  // Die Einwilligung prüft test/ich.test.ts; sie bleibt unter dem Pflichtwechsel gesperrt, ohne gültige Einwilligung aber offen
  "GET /api/v1/einwilligung": {
    erwartet: { ...alle(200), ...SPERREN, ohneEinwilligung: 200 },
  },
  "PUT /api/v1/einwilligung": {
    frischePersonas: true,
    erwartet: { ...alle(204), ...SPERREN, ohneEinwilligung: 204 },
  },
  // Sichtbar ist ein Programm für Kommando und Leitende der Einheit, für Eltern und Teilnehmende mit aktiver Person darin und für das Konto des Kantonsadmins (test/programme.test.ts). Die Sperre ohne zweiten Faktor gilt nur unter /api/v1/admin/*
  "GET /api/v1/programme": {
    // Ohne Fenster antwortet die Route 400, darum eine URL trotz fehlendem Pfad-Parameter
    url: () => "/api/v1/programme?von=2027-01-01&bis=2027-12-31",
    erwartet: { ...alle(200), ...SPERREN },
  },
  "GET /api/v1/programme/:id": {
    url: () => `/api/v1/programme/${programmId}`,
    erwartet: { ...SEHEN_JF_A, ...SPERREN },
  },
  // Kommando und Leitende der Einheit sowie das Konto des Kantonsadmins sehen alle, Eltern und Teilnehmende ihre eigenen Personen (test/anmeldung.test.ts)
  "GET /api/v1/programme/:id/teilnahmen": {
    url: () => `/api/v1/programme/${programmId}/teilnahmen`,
    erwartet: { ...SEHEN_JF_A, ...SPERREN },
  },
  // Es antwortet nur, wer mit der Person verknüpft ist (Eltern oder selbst); alle anderen, auch Kommando und Kantonsadmin, bekommen 404, auch für Personen derselben Einheit. Nach dem Wechsel aufs Kind-Konto verlieren die früheren Eltern den Zugriff (404). Eigenes, offenes Programm: Das von programmId hat am 6. März 2027 begonnen, ab dann wäre jedes 204 ein 409
  "PUT /api/v1/programme/:id/teilnahmen/:teilnehmendeId": {
    url: () =>
      `/api/v1/programme/${offenProgrammId}/teilnahmen/${welt.teilnehmende.jfA}`,
    // Immer dieselbe Antwort: Der Matrix-Lauf überschreibt sie nur mit sich selbst
    body: () => ({ status: "ja" }),
    erwartet: {
      ...alle(404),
      elternJfA: 204,
      elternAundB: 204,
      leitendeJfAElternKfA: 404,
      ...SPERREN,
    },
  },
  // Nur Kommando, Stellvertretungen und Leitende der Einheit melden sich selbst an; das Konto des Kantonsadmins sowie Eltern und Teilnehmende sehen das Programm, haben aber kein Recht (403)
  "PUT /api/v1/programme/:id/leitung": {
    url: () => `/api/v1/programme/${offenProgrammId}/leitung`,
    body: () => ({ status: "ja" }),
    erwartet: {
      ...alle(404),
      kantonsadmin: 403,
      kantonsadminOhneZweitenFaktor: 403,
      kommandoJfA: 204,
      stellvertretung1JfA: 204,
      stellvertretung2JfA: 204,
      leitendeJfA: 204,
      leitendeJfAElternKfA: 204,
      elternJfA: 403,
      elternAundB: 403,
      teilnehmendeSelbstJfA: 403,
      elternNachWechsel: 403,
      ...SPERREN,
    },
  },
  // Kontakt der Einheit (Kommandant/in): sichtbar für alle, die die Einheit sehen; die Nummer nur für Eltern und Teilnehmende darin (test/termine.test.ts)
  "GET /api/v1/einheiten/:einheitId/kontakt": {
    url: (w) => `/api/v1/einheiten/${w.einheit.jfA}/kontakt`,
    erwartet: { ...SEHEN_JF_A, ...SPERREN },
  },
  // Bild eines Rang-Abzeichens von JF A: wer die Einheit sieht, sieht es (test/termine.test.ts)
  "GET /api/v1/raenge/:id/abzeichen": {
    url: () => `/api/v1/raenge/${abzeichenRangId}/abzeichen`,
    erwartet: { ...SEHEN_JF_A, ...SPERREN },
  },
  // Betriebszahlen (#143): nur das Konto des Kantonsadmins mit zweitem Faktor; Inhalt in test/admin-system.test.ts
  "GET /api/v1/admin/system": {
    erwartet: {
      ...alle(403),
      kantonsadmin: 200,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "GET /api/v1/admin/system/requests": {
    erwartet: {
      ...alle(403),
      kantonsadmin: 200,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  // Übergabe: nur das Konto des Kantonsadmins. Der Body nennt die heutige Kommandantin: Eine echte Übergabe würde die Personas der Matrix umbauen, also antwortet die Route für den Kantonsadmin 409 GLEICHE_PERSON, nachdem alle Prüfungen bestanden sind. Status in test/kommando.test.ts begründet
  "POST /api/v1/admin/einheiten/:einheitId/kommando": {
    url: (w) => `/api/v1/admin/einheiten/${w.einheit.jfA}/kommando`,
    body: () => ({
      neuerKommandantId: standard.kommandoJfA.id,
      bisherigeRolle: { typ: "keine" },
    }),
    erwartet: { ...VERWALTEN_JF_A(403), kantonsadmin: 409 },
  },
  "GET /api/v1/admin/einheiten/:einheitId/zeitregeln": {
    url: (w) => `/api/v1/admin/einheiten/${w.einheit.jfA}/zeitregeln`,
    erwartet: VERWALTEN_JF_A(200),
  },
  "POST /api/v1/admin/einheiten/:einheitId/zeitregeln": {
    url: (w) => `/api/v1/admin/einheiten/${w.einheit.jfA}/zeitregeln`,
    body: () => ({
      wochentag: 3,
      uhrzeit: "08:00",
      text: "Matrix",
      aktiv: false,
    }),
    erwartet: VERWALTEN_JF_A(201),
  },
  "PATCH /api/v1/admin/einheiten/:einheitId/zeitregeln/:id": {
    url: (w) =>
      `/api/v1/admin/einheiten/${w.einheit.jfA}/zeitregeln/${patchRegelId}`,
    body: () => ({ aktiv: false }),
    erwartet: VERWALTEN_JF_A(204),
  },
  "DELETE /api/v1/admin/einheiten/:einheitId/zeitregeln/:id": {
    // Jede Anfrage verbraucht ihre Regel: eine frische pro Persona
    urlJeAnfrage: async () =>
      `/api/v1/admin/einheiten/${welt.einheit.jfA}/zeitregeln/${await wegwerfRegelId()}`,
    erwartet: VERWALTEN_JF_A(204),
  },
  // Profilbild (#173): Jede Person mit Sitzung lädt ihr eigenes hoch und löscht es; nur die Person selbst, nie eine andere. Typ, Grösse und Rate-Limit prüft test/profilbild.test.ts
  "PUT /api/v1/ich/bild": {
    bild: true,
    erwartet: { ...alle(204), ...SPERREN },
  },
  "DELETE /api/v1/ich/bild": {
    // Löscht das Bild der Persona; die Personas der Zeile darunter behalten ihres, darum eigene
    frischePersonas: true,
    erwartet: { ...alle(204), ...SPERREN },
  },
  // Ziel ist eine Stellvertretung von JF A mit Bild, also ein Kontakt der Einheit: Es sehen sie das Kantonsadmin-Konto, Kommando und Leitende der Einheit und Eltern und Teilnehmende darin (test/profilbild.test.ts)
  "GET /api/v1/personen/:id/bild": {
    url: () => `/api/v1/personen/${bildZielId}/bild`,
    erwartet: { ...SEHEN_JF_A, ...SPERREN },
  },
  "PUT /api/v1/push-token": {
    // Eigenes Token pro Persona: Die Zeile schreibt nur auf die eigene Sitzung, darum keine frischen Personas
    body: (konto) => ({
      token: `fcm-test-token-${konto.benutzername ?? "ohne-login"}`,
      plattform: "ios",
    }),
    erwartet: { ...alle(204), ...SPERREN },
  },
  // Auswertung auf Basis der Anmeldungen (E7), nur lesend; Inhalte und Mandantentrennung in test/auswertung.test.ts
  "GET /api/v1/admin/auswertung/filter": { erwartet: AUSWERTEN },
  "GET /api/v1/admin/auswertung/termine": {
    url: () => `/api/v1/admin/auswertung/termine?${JAHR_2025}`,
    erwartet: AUSWERTEN,
  },
  "GET /api/v1/admin/auswertung/quoten": {
    url: () => `/api/v1/admin/auswertung/quoten?${JAHR_2025}`,
    erwartet: AUSWERTEN,
  },
  "GET /api/v1/admin/auswertung/jahr": {
    url: () => "/api/v1/admin/auswertung/jahr?jahr=2025",
    erwartet: AUSWERTEN,
  },
  "GET /api/v1/admin/auswertung/termine/:id": {
    url: () => `/api/v1/admin/auswertung/termine/${programmId}`,
    erwartet: VERWALTEN_JF_A(200),
  },
  "GET /api/v1/admin/auswertung/einheiten/:einheitId/teilnehmende/:id": {
    url: (w) =>
      `/api/v1/admin/auswertung/einheiten/${w.einheit.jfA}/teilnehmende/${w.teilnehmende.jfA}?${JAHR_2025}`,
    erwartet: VERWALTEN_JF_A(200),
  },
  "GET /api/v1/admin/auswertung/einheiten/:einheitId/leitende/:id": {
    url: (w) =>
      `/api/v1/admin/auswertung/einheiten/${w.einheit.jfA}/leitende/${standard.kommandoJfA.id}?${JAHR_2025}`,
    erwartet: VERWALTEN_JF_A(200),
  },
  // Statische Datei der Verwaltung (Auswertung)
  "GET /admin/auswertung.js": { erwartet: alle(200) },
};

let welt: Welt;
let standard: Record<Persona, PersonaKonto>;
let programmId: string;
let offenProgrammId: string;
let abzeichenRangId: string;
let patchRegelId: string;
let bildZielId: string;
let testBild: Buffer;

async function wegwerfRegelId() {
  const [zeile] = await welt.db
    .insert(schema.zeitregel)
    .values({
      einheitId: welt.einheit.jfA,
      wochentag: 3,
      uhrzeit: "08:00",
      text: "Wegwerf",
      aktiv: false,
    })
    .returning({ id: schema.zeitregel.id });
  return zeile.id;
}

// Promise.all geht: Die Fabrik teilt keinen veränderlichen Zustand (zufällige Namen, eigene Inserts)
async function personasAnlegen(w: Welt) {
  return Object.fromEntries(
    await Promise.all(
      PERSONAS.map(async (p) => [p, await legePersonaAn(w, p)]),
    ),
  ) as Record<Persona, PersonaKonto>;
}

beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  standard = await personasAnlegen(welt);
  // Programme von JF A für die Objekt-Routen: eines mit Beginn im März 2027, eines in zehn Tagen (offen für Anmeldungen, im Anmeldefenster)
  programmId = (await legeProgrammAn(db, { einheitId: welt.einheit.jfA })).id;
  offenProgrammId = (
    await legeProgrammAn(db, {
      einheitId: welt.einheit.jfA,
      beginn: new Date(Date.now() + 10 * 86_400_000),
    })
  ).id;
  // Ein Rang mit eigenem Bild (PNG), den die Route ausliefert
  [{ id: abzeichenRangId }] = await db
    .insert(schema.rang)
    .values({
      einheitId: welt.einheit.jfA,
      name: "Rang Bild",
      kuerzel: "RB",
      reihenfolge: 2,
      abzeichenBild: await sharp({
        create: { width: 8, height: 8, channels: 3, background: "#cc3333" },
      })
        .png()
        .toBuffer(),
      abzeichenBildTyp: "png",
    })
    .returning({ id: schema.rang.id });
  patchRegelId = await wegwerfRegelId();
  testBild = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "#3366cc" },
  })
    .jpeg()
    .toBuffer();
  // Wegwerf-Person als Stellvertretung Nr. 9 von JF A, direkt eingefügt (ohne Passwort), mit Bild
  const [zeile] = await db
    .insert(schema.user)
    .values({
      name: "Wegwerf Person",
      email: `${randomUUID()}@example.org`,
      username: `wegwerf.${randomUUID().slice(0, 8)}`,
      mussPasswortAendern: false,
    })
    .returning({ id: schema.user.id });
  bildZielId = zeile.id;
  await db.insert(schema.einheitRolle).values({
    userId: bildZielId,
    einheitId: welt.einheit.jfA,
    typ: "stellvertretung",
    reihenfolge: 9,
  });
  await db
    .insert(schema.profilbild)
    .values({ userId: bildZielId, inhalt: testBild });
});

// Rund 1 500 Anfragen schrieben sonst je eine Log-Zeile und begrüben jeden Fehler
let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

// Unter MIDDLEWARE nur Middleware; Routen registrieren Issues nie mit all() oder use()
const MIDDLEWARE = new Set([
  "ALL /*",
  "ALL /api/*",
  "ALL /api/v1/*",
  "ALL /api/v1/admin/*",
]);

type Instanz = { routes: { method: string; path: string }[] };
const schluesselVon = (instanz: Instanz) =>
  new Set(instanz.routes.map((r) => `${r.method} ${r.path}`));
const ohneZeile = (instanz: Instanz) =>
  [...schluesselVon(instanz)]
    .filter((s) => !(s in MATRIX) && !MIDDLEWARE.has(s))
    .sort();

describe("Vollständigkeit", () => {
  test("jede Route hat eine Zeile und jede Zeile eine Route", () => {
    const routen = schluesselVon(app);
    expect(ohneZeile(app)).toEqual([]);
    expect(Object.keys(MATRIX).filter((s) => !routen.has(s))).toEqual([]);
    expect([...MIDDLEWARE].filter((s) => !routen.has(s))).toEqual([]);
  });

  test("Selbsttest: Eine Route ohne Zeile fällt mit genau ihrem Schlüssel auf", () => {
    const mitExtra = erstelleApp({
      appMinVersion: "1.2.0",
      sql,
      db,
      auth,
      seiten: ladeSeiten(),
    }).get("/api/v1/ohne-eintrag", (c) => c.text("nie"));
    expect(ohneZeile(mitExtra)).toEqual(["GET /api/v1/ohne-eintrag"]);
  });

  // Mandantentrennung: Wer die Einheit nicht kennt (anderer Bezirk, andere Art), sieht kein Objekt dieser Einheit; bindet jede künftige Objekt-Route. Bewusst eine Schleife: Ein leeres test.each ergäbe gar keinen Test
  test("jede Zeile mit Pfad-Parameter nennt eine URL und erwartet 404 für das Kommando von KF A, von JF B und die Eltern von KF A", () => {
    for (const [schluessel, zeile] of Object.entries(MATRIX)) {
      if (!schluessel.includes(":")) continue;
      expect(zeile.url ?? zeile.urlJeAnfrage, schluessel).toBeDefined();
      // Routen der eigenen Person und der Verwaltung ohne Objekt der Einheit ausgenommen
      if (schluessel.includes("/admin/system")) continue;
      for (const persona of [
        "kommandoKfA",
        "kommandoJfB",
        "elternKfA",
      ] as const) {
        expect(zeile.erwartet[persona], `${schluessel} ${persona}`).toBe(404);
      }
    }
  });

  test("keine Antwort einer Route erlaubt, dass die App eine Einheit mitschickt", () => {
    // Die App schickt nie eine Einheit mit: Kein Body-Feld der Matrix heisst einheitId
    for (const [schluessel, zeile] of Object.entries(MATRIX)) {
      if (!zeile.body) continue;
      const platzhalter = { benutzername: "x", passwort: "y" } as PersonaKonto;
      expect(Object.keys(zeile.body(platzhalter)), schluessel).not.toContain(
        "einheitId",
      );
    }
  });
});

describe("Sperre ohne zweiten Faktor (#23)", () => {
  // Bewusst eine Schleife: Jede künftige Admin-Route erbt die Regel; ein leeres test.each ergäbe gar keinen Test
  test("jede Admin-Route erwartet für Kantonsadmin und Kommando ohne zweiten Faktor 403", () => {
    let n = 0;
    for (const [schluessel, zeile] of Object.entries(MATRIX)) {
      if (!schluessel.split(" ")[1].startsWith("/api/v1/admin/")) continue;
      n++;
      expect(zeile.erwartet.kantonsadminOhneZweitenFaktor, schluessel).toBe(
        403,
      );
      expect(zeile.erwartet.kommandoKfBOhneZweitenFaktor, schluessel).toBe(403);
    }
    expect(n).toBeGreaterThan(0);
  });

  test("Konten mit Verwaltungsrolle ohne Faktor bekommen ZWEITER_FAKTOR_FEHLT, alle anderen den Status der Route", async () => {
    const pfad = `/api/v1/admin/einheiten/${welt.einheit.jfA}/zeitregeln`;
    const anfrageAn = (persona: Persona, url = pfad) =>
      app.request(url, { headers: standard[persona].headers });
    for (const persona of [
      "kantonsadminOhneZweitenFaktor",
      "kommandoKfBOhneZweitenFaktor",
    ] as const) {
      const ohne = await anfrageAn(persona);
      expect(ohne.status, persona).toBe(403);
      expect(await ohne.json(), persona).toEqual({
        code: "ZWEITER_FAKTOR_FEHLT",
        message: "Für die Verwaltung braucht es zuerst einen zweiten Faktor.",
      });
    }
    const eltern = await anfrageAn("elternJfA");
    expect(eltern.status).toBe(403);
    expect(await eltern.json()).toMatchObject({ code: "KEINE_BERECHTIGUNG" });
    expect((await anfrageAn("kommandoJfA")).status).toBe(200);
    expect((await anfrageAn("kantonsadmin")).status).toBe(200);
  });
});

describe("Matrix: jede Route mal jede Persona", () => {
  test.each(Object.entries(MATRIX))("%s", async (schluessel, zeile) => {
    const [methode, pfad] = schluessel.split(" ");
    // Eigene Personas in einer eigenen Welt: Kommandant und Positionen gibt es je Einheit nur einmal
    const eigene = zeile.frischePersonas
      ? await personasAnlegen(await erstelleWelt(db, auth))
      : standard;
    const festeUrl = zeile.url?.(welt) ?? pfad;
    const ergebnis: Partial<Record<Persona, number>> = {};
    for (const persona of PERSONAS) {
      const konto = eigene[persona];
      const url = zeile.urlJeAnfrage ? await zeile.urlJeAnfrage() : festeUrl;
      const antwort = await app.request(url, {
        method: methode,
        headers: zeile.body
          ? { ...konto.headers, "content-type": "application/json" }
          : konto.headers,
        body: zeile.bild
          ? new Uint8Array(testBild)
          : zeile.body && JSON.stringify(zeile.body(konto)),
      });
      ergebnis[persona] = antwort.status;
    }
    expect(ergebnis).toEqual(zeile.erwartet);
  });
});

describe("jeder übrige better-auth-Pfad liefert 404 aus der App", () => {
  const geschlossen = geschlossenePfade(
    Object.keys(MATRIX).filter((s) => s.includes(" /api/auth/")),
  );

  test("die Liste enthält die kritischen Pfade", () => {
    expect(geschlossen).toEqual(
      expect.arrayContaining([
        "POST /api/auth/update-user",
        "POST /api/auth/sign-in/email",
        "POST /api/auth/sign-up/email",
        "POST /api/auth/is-username-available",
        "POST /api/auth/admin/create-user",
        "POST /api/auth/admin/ban-user",
      ]),
    );
  });

  test.each(geschlossen)("%s", async (eintrag) => {
    const [methode, pfad] = eintrag.split(" ");
    for (const persona of PERSONAS) {
      const antwort = await app.request(pfad, {
        method: methode,
        headers: standard[persona].headers,
      });
      expect(antwort.status, persona).toBe(404);
      // Der Body der App, nicht der von better-auth: Die Anfrage hat auth.handler nie erreicht
      expect(await antwort.json(), persona).toEqual({
        code: "NICHT_GEFUNDEN",
        message: "Nicht gefunden",
      });
    }
  });
});

// Export für docs/api/endpunkte.md und die Postman-Collection (#186): läuft nur mit POSTMAN_EXPORT=1, schreibt die Zeilen der Matrix mit ID-Platzhaltern und je Persona eine Umgebung mit Sitzung. Die Datenbank bleibt danach stehen, die API kann auf ihr laufen (docs/api/postman.md)
describe.runIf(process.env.POSTMAN_EXPORT)("Postman-Export", () => {
  test("schreibt apps/api/.postman-lokal/", async () => {
    const ordner = new URL("../.postman-lokal/", import.meta.url);
    await mkdir(ordner, { recursive: true });
    const ids: Record<string, string> = {
      bezirkAId: welt.bezirkAId,
      bezirkBId: welt.bezirkBId,
      rangId: welt.rangId,
      ...Object.fromEntries(
        Object.entries(welt.einheit).map(([k, v]) => [`einheit_${k}`, v]),
      ),
      ...Object.fromEntries(
        Object.entries(welt.teilnehmende).map(([k, v]) => [
          `teilnehmende_${k}`,
          v,
        ]),
      ),
      programmId,
      offenProgrammId,
      abzeichenRangId,
      patchRegelId,
      bildZielId,
      elternJfAUserId: standard.elternJfA.id!,
      kommandoJfAUserId: standard.kommandoJfA.id!,
    };
    const ersetze = (text: string) =>
      Object.entries(ids).reduce(
        (t, [name, id]) => t.replaceAll(id, `{{${name}}}`),
        text,
      );
    const platzhalter = {
      benutzername: "{{benutzername}}",
      passwort: "{{passwort}}",
    } as PersonaKonto;
    const uuid = /[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/;

    const zeilen = Object.entries(MATRIX).map(([schluessel, zeile], n) => ({
      schluessel,
      methode: schluessel.split(" ")[0],
      pfad: ersetze(zeile.url?.(welt) ?? schluessel.split(" ")[1]),
      body: zeile.body && ersetze(JSON.stringify(zeile.body(platzhalter))),
      bild: zeile.bild === true,
      zielJeAnfrage: zeile.urlJeAnfrage !== undefined,
      sitzungEnde: zeile.frischePersonas === true,
      bodyJePersona: false,
      erwartet: zeile.erwartet,
      n,
    }));
    for (const z of zeilen.filter((z) => z.zielJeAnfrage)) {
      z.pfad = ersetze(await MATRIX[z.schluessel].urlJeAnfrage!()).replace(
        uuid,
        `{{ziel_${z.n}}}`,
      );
    }

    // Bodies, die von der Persona abhängen, stehen als Variable body_<n> in deren Umgebung
    const bodyJePersona = (z: (typeof zeilen)[number], persona: Persona) => {
      const konto = standard[persona];
      const text = ersetze(JSON.stringify(MATRIX[z.schluessel].body!(konto)));
      return text
        .replaceAll(konto.benutzername ?? " ", "{{benutzername}}")
        .replaceAll(konto.passwort ?? " ", "{{passwort}}");
    };
    for (const z of zeilen.filter((z) => z.body)) {
      const texte = PERSONAS.map((p) => bodyJePersona(z, p));
      if (texte.some((t) => t !== z.body)) z.bodyJePersona = true;
    }
    await writeFile(
      new URL("matrix.json", ordner),
      JSON.stringify({ personas: PERSONAS, zeilen }, null, 1),
    );

    for (const persona of PERSONAS) {
      const konto = standard[persona];
      const werte: Record<string, string> = {
        baseUrl: "http://localhost:3000",
        persona,
        expoOrigin: konto.headers["expo-origin"],
        ip: konto.headers["x-forwarded-for"],
        cookie: konto.headers.cookie ?? "",
        benutzername: konto.benutzername ?? "gibt.es.nicht",
        passwort: konto.passwort ?? PASSWORT,
        ...ids,
        erwartet: JSON.stringify(
          Object.fromEntries(
            zeilen.map((z) => [z.schluessel, z.erwartet[persona]]),
          ),
        ),
      };
      for (const z of zeilen.filter((z) => z.bodyJePersona))
        werte[`body_${z.n}`] = bodyJePersona(z, persona);
      for (const z of zeilen.filter((z) => z.zielJeAnfrage)) {
        const url = await MATRIX[z.schluessel].urlJeAnfrage!();
        werte[`ziel_${z.n}`] = uuid.exec(url.split("/zeitregeln/")[1])![0];
      }
      const geheim = new Set(["cookie", "passwort"]);
      await writeFile(
        new URL(`${persona}.environment.yaml`, ordner),
        // JSON ist gültiges YAML; so bleibt jeder Wert eine Zeichenkette
        JSON.stringify({
          name: `FireResponse lokal: ${persona}`,
          values: Object.entries(werte).map(([key, value]) => ({
            key,
            value,
            enabled: true,
            type: geheim.has(key) ? "secret" : "default",
          })),
        }),
      );
    }
  });
});
