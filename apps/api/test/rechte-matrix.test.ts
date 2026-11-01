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
  // Für Zeilen, die die Sitzungen der geteilten Personas beenden würden
  frischePersonas?: true;
  // Pflicht für jede Route mit Pfad-Parameter: ein Objekt der Testabteilung
  url?: (welt: Welt) => string;
  // Statt url, wenn jede Anfrage ihr Ziel verbraucht (DELETE): eine frische URL pro Persona
  urlJeAnfrage?: () => Promise<string>;
}

const alle = (status: number) =>
  Object.fromEntries(PERSONAS.map((p) => [p, status])) as Record<
    Persona,
    number
  >;

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
  "GET /admin/kinder.js": { erwartet: alle(200) },
  "GET /admin/personen.js": { erwartet: alle(200) },
  "GET /admin/stufen.js": { erwartet: alle(200) },
  "GET /admin/system.js": { erwartet: alle(200) },
  "GET /admin/uebersicht.js": { erwartet: alle(200) },
  "GET /admin/zeitregeln.js": { erwartet: alle(200) },
  "GET /admin/csv.js": { erwartet: alle(200) },
  "GET /admin/import.js": { erwartet: alle(200) },
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
  "POST /api/auth/two-factor/verify-totp": {
    // Falscher Code; mit Sitzung zählt better-auth keinen Fehlversuch, Sperre und Versuchsbudget gelten nur der Anmeldung
    body: () => ({ code: "000000" }),
    erwartet: {
      ...alle(400),
      admin: 401,
      demoAdmin: 401,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "POST /api/auth/two-factor/verify-backup-code": {
    body: () => ({ code: "falsch-falsch" }),
    erwartet: {
      ...alle(400),
      admin: 401,
      demoAdmin: 401,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "POST /api/auth/two-factor/enable": {
    body: () => ({ password: FALSCH }),
    erwartet: {
      ...alle(404),
      admin: 400,
      adminOhneZweitenFaktor: 400,
      demoAdmin: 400,
    },
  },
  // Die Felder je Rolle prüft test/ich.test.ts; GET /ich bleibt als einzige /api/v1-Route auch unter dem Pflichtwechsel offen (#15)
  "GET /api/v1/ich": {
    erwartet: { ...alle(200), deaktiviert: 401, ohneLogin: 401 },
  },
  "POST /api/v1/ich/datenschutz": {
    // Schreibt datenschutz_gelesen_am, darum eigene Personas
    frischePersonas: true,
    erwartet: {
      ...alle(204),
      mussPasswortAendern: 403,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "PATCH /api/v1/ich": {
    // Schreibt push_anmeldungen, darum eigene Personas; die Felder prüft test/ich.test.ts
    frischePersonas: true,
    body: () => ({ pushAnmeldungen: false }),
    erwartet: {
      ...alle(204),
      mussPasswortAendern: 403,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  // Die Felder je Rolle prüft test/programme.test.ts, die Zuordnungsregeln test/zuordnung.test.ts; hier zählt der Status.
  // adminOhneZweitenFaktor wie admin: #23 sperrt nur /api/v1/admin/*. mussPasswortAendern: #15 sperrt das Konto auf allen Routen ausser GET /api/v1/ich
  "GET /api/v1/programme": {
    // Ohne Fenster antwortet die Route 400, darum eine URL trotz fehlendem Pfad-Parameter
    url: () => "/api/v1/programme?von=2027-01-01&bis=2027-12-31",
    erwartet: {
      ...alle(200),
      mussPasswortAendern: 403,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "GET /api/v1/programme/:id": {
    url: () => `/api/v1/programme/${programmId}`,
    erwartet: {
      ...alle(200),
      mussPasswortAendern: 403,
      leitendeB: 404,
      elternB: 404,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  // Kontakte (#39): Namen der SL für alle, die das Programm sehen; die Nummer gibt es nur Eltern mit aktivem Kind in der Stufe der SL (test/kontakte.test.ts). Antworten tragen Cache-Control: no-store
  "GET /api/v1/programme/:id/kontakte": {
    url: () => `/api/v1/programme/${programmId}/kontakte`,
    erwartet: {
      ...alle(200),
      mussPasswortAendern: 403,
      leitendeB: 404,
      elternB: 404,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  "PUT /api/v1/programme/:id/zuordnung": {
    url: () => `/api/v1/programme/${programmId}/zuordnung`,
    // Der aktuelle Stand als No-op: Der Matrix-Lauf verändert nichts
    body: () => ({ stufen: [welt.stufeAId], sichtbarkeit: "eltern" }),
    erwartet: {
      ...alle(204),
      leitendeA: 403,
      leitendeAElternB: 403,
      elternA: 403,
      mussPasswortAendern: 403,
      leitendeB: 404,
      elternB: 404,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  "PUT /api/v1/programme/:id/teilnahmen/:kindId": {
    url: () => `/api/v1/programme/${programmId}/teilnahmen/${welt.kindAId}`,
    // Immer dieselbe Antwort: Der Matrix-Lauf überschreibt sie nur mit sich selbst
    body: () => ({ status: "ja" }),
    // Zuständig sind Admins, die Leitung der Stufe des Kindes (SL eingeschlossen) und die Eltern des Kindes; slB sieht das Programm, ist aber für Stufe A nicht zuständig
    erwartet: {
      ...alle(204),
      slB: 403,
      mussPasswortAendern: 403,
      leitendeB: 404,
      elternB: 404,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  // Übersicht (#38): Admin sowie Leitung und SL der Stufe sehen die Liste, Eltern ihr Kind; slB sieht das Programm, hat aber kein Recht darauf. Die Inhalte je Rolle prüft test/teilnahmen-uebersicht.test.ts
  "GET /api/v1/programme/:id/teilnahmen": {
    url: () => `/api/v1/programme/${programmId}/teilnahmen`,
    erwartet: {
      ...alle(200),
      slB: 403,
      mussPasswortAendern: 403,
      leitendeB: 404,
      elternB: 404,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  // Eigenes Programm mit Beginn in einem Jahr: Das von programmId hat am 6. März 2027 begonnen, ab dann wäre jedes 204 ein 409. Admin und SL anderer Stufen sehen es, haben aber kein Recht
  "PUT /api/v1/programme/:id/leitung": {
    url: () => `/api/v1/programme/${leitungProgrammId}/leitung`,
    body: () => ({ status: "ja" }),
    erwartet: {
      ...alle(204),
      admin: 403,
      adminOhneZweitenFaktor: 403,
      slB: 403,
      elternA: 403,
      mussPasswortAendern: 403,
      leitendeB: 404,
      elternB: 404,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  // Verwaltung (#18): nur Admins, und ohne zweiten Faktor sperrt die Middleware (#23) jede Admin-Route mit 403. Status in test/admin-personen.test.ts begründet
  // Betriebszahlen (#143): nur Admins, wie die übrigen Admin-Routen; Inhalt in test/admin-system.test.ts
  "GET /api/v1/admin/system": {
    erwartet: {
      ...alle(403),
      admin: 200,
      adminOhneZweitenFaktor: 403,
      demoAdmin: 200,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "GET /api/v1/admin/system/requests": {
    erwartet: {
      ...alle(403),
      admin: 200,
      adminOhneZweitenFaktor: 403,
      demoAdmin: 200,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "GET /api/v1/admin/personen": {
    erwartet: {
      ...alle(403),
      admin: 200,
      adminOhneZweitenFaktor: 403,
      demoAdmin: 200,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "POST /api/v1/admin/personen": {
    // Eigener Benutzername pro Persona; leere Listen, weil Testabteilungs-IDs dem demoAdmin 400 gäben
    body: () => ({
      vorname: "Matrix",
      nachname: "Person",
      benutzername: `matrix.${randomUUID().slice(0, 8)}`,
      admin: false,
      rollen: [],
      elternteilVon: [],
    }),
    erwartet: {
      ...alle(403),
      admin: 201,
      adminOhneZweitenFaktor: 403,
      demoAdmin: 201,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "PATCH /api/v1/admin/personen/:id": {
    url: () => `/api/v1/admin/personen/${patchZielId}`,
    body: () => ({ name: "Matrix Person" }),
    erwartet: {
      ...alle(403),
      admin: 204,
      adminOhneZweitenFaktor: 403,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  "POST /api/v1/admin/personen/:id/startpasswort": {
    url: () => `/api/v1/admin/personen/${startpasswortZielId}/startpasswort`,
    erwartet: {
      ...alle(403),
      admin: 200,
      adminOhneZweitenFaktor: 403,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  "POST /api/v1/admin/personen/:id/deaktivieren": {
    url: () => `/api/v1/admin/personen/${deaktivierenZielId}/deaktivieren`,
    erwartet: {
      ...alle(403),
      admin: 204,
      adminOhneZweitenFaktor: 403,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  "POST /api/v1/admin/personen/:id/aktivieren": {
    url: () => `/api/v1/admin/personen/${aktivierenZielId}/aktivieren`,
    erwartet: {
      ...alle(403),
      admin: 204,
      adminOhneZweitenFaktor: 403,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  "POST /api/v1/admin/personen/:id/zweiter-faktor-zuruecksetzen": {
    // Jede Anfrage setzt den Faktor ihres Ziels zurück; ein Ziel mit Faktor je Anfrage
    urlJeAnfrage: async () =>
      `/api/v1/admin/personen/${await wegwerfPersonId(true)}/zweiter-faktor-zuruecksetzen`,
    erwartet: {
      ...alle(403),
      admin: 204,
      adminOhneZweitenFaktor: 403,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  "DELETE /api/v1/admin/personen/:id": {
    // Jede Anfrage löscht ihr Ziel; eine feste URL nähme es allen nach dem ersten Admin weg
    urlJeAnfrage: async () =>
      `/api/v1/admin/personen/${await wegwerfPersonId()}`,
    erwartet: {
      ...alle(403),
      admin: 204,
      adminOhneZweitenFaktor: 403,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  // Stufen und Kinder (#19): GET /stufen liest jede Person mit Sitzung, die übrigen Routen nur Admins. PATCH-Bodies mit den aktuellen Werten, damit der Lauf nichts verändert; Status in test/admin-stufen.test.ts und test/admin-kinder.test.ts begründet
  "GET /api/v1/stufen": {
    erwartet: {
      ...alle(200),
      mussPasswortAendern: 403,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  // Kontakte der Stufe (#39): Admin, Leitende und SL der Stufe sowie Eltern mit aktivem Kind darin; alle anderen und fremde Abteilungen sehen die Stufe nicht
  "GET /api/v1/stufen/:id/kontakte": {
    url: () => `/api/v1/stufen/${welt.stufeAId}/kontakte`,
    erwartet: {
      ...alle(200),
      slB: 404,
      leitendeB: 404,
      elternB: 404,
      mussPasswortAendern: 403,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  // Profilbild (#173): Jede Person mit Sitzung lädt ihr eigenes hoch und löscht es; nur die Person selbst, nie eine andere. Typ, Grösse und Rate-Limit prüft test/profilbild.test.ts. Das Bild einer Person sieht, wer ihren Namen ohnehin sieht; die Wege dahin ebenfalls dort
  "PUT /api/v1/ich/bild": {
    bild: true,
    erwartet: {
      ...alle(204),
      mussPasswortAendern: 403,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "DELETE /api/v1/ich/bild": {
    // Löscht das Bild der Persona; slA und Co. behalten ihres für die Zeile darunter
    frischePersonas: true,
    erwartet: {
      ...alle(204),
      mussPasswortAendern: 403,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  // Ziel ist eine SL der Stufe A ohne Abmeldung: Es bleiben die Kontakte der Stufe (Admin, Leitende und SL der Stufe, Eltern mit aktivem Kind darin) und die Kontakte der Programme der Stufe A (slB: Eine SL sieht jedes Programm, und «offen» bleibt Kontakt)
  "GET /api/v1/personen/:id/bild": {
    url: () => `/api/v1/personen/${bildZielId}/bild`,
    erwartet: {
      ...alle(200),
      leitendeB: 404,
      elternB: 404,
      mussPasswortAendern: 403,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  "POST /api/v1/admin/stufen": {
    // Jeder Aufruf braucht einen eigenen Namen: In einer Abteilung ist er eindeutig
    body: () => ({ name: `Matrix Stufe ${++stufenZaehler}`, kuerzel: "M" }),
    erwartet: {
      ...alle(403),
      admin: 201,
      adminOhneZweitenFaktor: 403,
      demoAdmin: 201,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "PATCH /api/v1/admin/stufen/:id": {
    url: () => `/api/v1/admin/stufen/${patchStufeId}`,
    body: () => ({ name: `Matrix Stufe ${++stufenZaehler}`, kuerzel: "M" }),
    erwartet: {
      ...alle(403),
      admin: 204,
      adminOhneZweitenFaktor: 403,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  // Reihenfolge der SL einer Stufe (#287): nur Admins; Wirkung und Fehler in test/admin-stufen.test.ts
  "PUT /api/v1/admin/stufen/:id/stufenleitung": {
    url: () => `/api/v1/admin/stufen/${patchStufeId}/stufenleitung`,
    body: () => ({ ids: [] }),
    erwartet: {
      ...alle(403),
      admin: 204,
      adminOhneZweitenFaktor: 403,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  "DELETE /api/v1/admin/stufen/:id": {
    // Jede Anfrage löscht ihr Ziel; die Antworten für Eltern und SL (403) lassen es stehen
    urlJeAnfrage: async () => `/api/v1/admin/stufen/${await wegwerfStufeId()}`,
    erwartet: {
      ...alle(403),
      admin: 204,
      adminOhneZweitenFaktor: 403,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  "GET /api/v1/admin/kinder": {
    erwartet: {
      ...alle(403),
      admin: 200,
      adminOhneZweitenFaktor: 403,
      demoAdmin: 200,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "POST /api/v1/admin/kinder": {
    // Die Stufe der eigenen Abteilung: Mit einer fremden gäbe der Demo-Admin 400
    body: (konto) => ({
      vorname: "Matrix",
      nachname: "Kind",
      stufeId:
        konto.abteilungId === welt.demoAbteilungId
          ? welt.demoStufeId
          : welt.stufeAId,
    }),
    erwartet: {
      ...alle(403),
      admin: 201,
      adminOhneZweitenFaktor: 403,
      demoAdmin: 201,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  // Je Persona eine eigene Zeile mit zufälligem Namen; nur Kinder, damit kein Konto (scrypt) entsteht
  "POST /api/v1/admin/import/vorschau": {
    body: (konto) => ({
      stufeId:
        konto.abteilungId === welt.demoAbteilungId
          ? welt.demoStufeId
          : welt.stufeAId,
      zeilen: [{ vorname: "Matrix", nachname: randomUUID(), art: "kind" }],
    }),
    erwartet: {
      ...alle(403),
      admin: 200,
      adminOhneZweitenFaktor: 403,
      demoAdmin: 200,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "POST /api/v1/admin/import": {
    body: (konto) => ({
      stufeId:
        konto.abteilungId === welt.demoAbteilungId
          ? welt.demoStufeId
          : welt.stufeAId,
      zeilen: [{ vorname: "Matrix", nachname: randomUUID(), art: "kind" }],
    }),
    erwartet: {
      ...alle(403),
      admin: 201,
      adminOhneZweitenFaktor: 403,
      demoAdmin: 201,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "PATCH /api/v1/admin/kinder/:id": {
    url: () => `/api/v1/admin/kinder/${patchKindId}`,
    // Ohne eltern: Die Liste von Kind A hinge von den angelegten Personas ab
    body: () => ({
      vorname: "Matrix",
      nachname: "Kind",
      stufeId: welt.stufeAId,
      aktiv: true,
    }),
    erwartet: {
      ...alle(403),
      admin: 204,
      adminOhneZweitenFaktor: 403,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  "DELETE /api/v1/admin/kinder/:id": {
    // Jede Anfrage löscht ihr Ziel
    urlJeAnfrage: async () => `/api/v1/admin/kinder/${await wegwerfKindId()}`,
    erwartet: {
      ...alle(403),
      admin: 204,
      adminOhneZweitenFaktor: 403,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  "GET /api/v1/admin/zeitregeln": {
    erwartet: {
      ...alle(403),
      admin: 200,
      adminOhneZweitenFaktor: 403,
      demoAdmin: 200,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "POST /api/v1/admin/zeitregeln": {
    body: () => ({
      stufeId: null,
      wochentag: 3,
      uhrzeit: "08:00",
      text: "{Programm} am {Datum}",
      aktiv: true,
    }),
    erwartet: {
      ...alle(403),
      admin: 201,
      adminOhneZweitenFaktor: 403,
      demoAdmin: 201,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
  "PATCH /api/v1/admin/zeitregeln/:id": {
    url: () => `/api/v1/admin/zeitregeln/${patchRegelId}`,
    body: () => ({ uhrzeit: "09:30" }),
    erwartet: {
      ...alle(403),
      admin: 204,
      adminOhneZweitenFaktor: 403,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  "DELETE /api/v1/admin/zeitregeln/:id": {
    // Jede Anfrage löscht ihr Ziel
    urlJeAnfrage: async () =>
      `/api/v1/admin/zeitregeln/${await wegwerfRegelId()}`,
    erwartet: {
      ...alle(403),
      admin: 204,
      adminOhneZweitenFaktor: 403,
      deaktiviert: 401,
      ohneLogin: 401,
      demoAdmin: 404,
      demoEltern: 404,
    },
  },
  "PUT /api/v1/push-token": {
    // Eigenes Token pro Persona: Die Zeile schreibt nur auf die eigene Sitzung, darum keine frischen Personas
    body: (konto) => ({
      token: `fcm-test-token-${konto.benutzername ?? "ohne-login"}`,
      plattform: "ios",
    }),
    erwartet: {
      ...alle(204),
      mussPasswortAendern: 403,
      deaktiviert: 401,
      ohneLogin: 401,
    },
  },
};

let welt: Welt;
let standard: Record<Persona, PersonaKonto>;
let programmId: string;
let leitungProgrammId: string;
let patchZielId: string;
let startpasswortZielId: string;
let deaktivierenZielId: string;
let aktivierenZielId: string;
let patchStufeId: string;
let stufenZaehler = 0;
let patchKindId: string;
let patchRegelId: string;
let bildZielId: string;
let testBild: Buffer;

// Wegwerf-Person der Testabteilung, direkt eingefügt (ohne Passwort): Die :id-Zeilen brauchen nur die Zeile; wer einen zweiten Faktor braucht, bekommt das Flag und eine Zeile in two_factor
async function wegwerfPersonId(zweiterFaktor = false) {
  const [zeile] = await welt.db
    .insert(schema.user)
    .values({
      name: "Wegwerf Person",
      email: `${randomUUID()}@example.org`,
      username: `wegwerf.${randomUUID().slice(0, 8)}`,
      abteilungId: welt.testabteilungId,
      mussPasswortAendern: false,
      twoFactorEnabled: zweiterFaktor,
    })
    .returning({ id: schema.user.id });
  if (zweiterFaktor) {
    await welt.db
      .insert(schema.twoFactor)
      .values({ userId: zeile.id, secret: "x", backupCodes: "x" });
  }
  return zeile.id;
}

// Wegwerf-Stufe der Testabteilung ohne Kinder und Leitung: Die Löschroute darf sie wegnehmen
async function wegwerfStufeId() {
  const [zeile] = await welt.db
    .insert(schema.stufe)
    .values({
      abteilungId: welt.testabteilungId,
      name: `Wegwerf Stufe ${randomUUID()}`,
      kuerzel: "W",
    })
    .returning({ id: schema.stufe.id });
  return zeile.id;
}

// Wegwerf-Kind der Testabteilung, direkt eingefügt; die Matrix-Zeilen fassen nie Kind A und B der Welt an
async function wegwerfKindId() {
  const [zeile] = await welt.db
    .insert(schema.kind)
    .values({
      abteilungId: welt.testabteilungId,
      vorname: "Wegwerf",
      nachname: "Kind",
      stufeId: welt.stufeAId,
    })
    .returning({ id: schema.kind.id });
  return zeile.id;
}

async function wegwerfRegelId() {
  const [zeile] = await welt.db
    .insert(schema.zeitregel)
    .values({
      abteilungId: welt.testabteilungId,
      wochentag: 3,
      uhrzeit: "08:00",
      text: "Wegwerf",
      aktiv: false,
    })
    .returning({ id: schema.zeitregel.id });
  return zeile.id;
}

// Promise.all geht: Die Fabrik teilt keinen veränderlichen Zustand (zufällige Namen, eigene Inserts)
async function personasAnlegen() {
  return Object.fromEntries(
    await Promise.all(
      PERSONAS.map(async (p) => [p, await legePersonaAn(welt, p)]),
    ),
  ) as Record<Persona, PersonaKonto>;
}

beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  standard = await personasAnlegen();
  // Ein Programm der Testabteilung für die Objekt-Routen, sichtbar bis zu den Eltern der Stufe A
  const programm = await legeProgrammAn(db, {
    abteilungId: welt.testabteilungId,
    sichtbarkeit: "eltern",
    stufen: [welt.stufeAId],
  });
  programmId = programm.id;
  leitungProgrammId = (
    await legeProgrammAn(db, {
      abteilungId: welt.testabteilungId,
      sichtbarkeit: "eltern",
      stufen: [welt.stufeAId],
      beginn: new Date(Date.now() + 365 * 86_400_000),
    })
  ).id;
  [patchZielId, startpasswortZielId, deaktivierenZielId, aktivierenZielId] =
    await Promise.all([
      wegwerfPersonId(),
      wegwerfPersonId(),
      wegwerfPersonId(),
      wegwerfPersonId(),
    ]);
  patchKindId = await wegwerfKindId();
  patchRegelId = await wegwerfRegelId();
  testBild = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "#3366cc" },
  })
    .jpeg()
    .toBuffer();
  bildZielId = await wegwerfPersonId();
  await db.insert(schema.rolle).values({
    userId: bildZielId,
    stufeId: welt.stufeAId,
    typ: "stufenleitung",
  });
  await db
    .insert(schema.profilbild)
    .values({ userId: bildZielId, inhalt: testBild });
  const [patchStufe] = await db
    .insert(schema.stufe)
    .values({
      abteilungId: welt.testabteilungId,
      name: "Matrix Stufe",
      kuerzel: "M",
    })
    .returning({ id: schema.stufe.id });
  patchStufeId = patchStufe.id;
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

  // Bedrohung 9: Demo-Personas sehen kein Objekt der echten Abteilung; bindet jede künftige Objekt-Route. Bewusst eine Schleife: Ein leeres test.each ergäbe gar keinen Test
  test("jede Zeile mit Pfad-Parameter nennt eine URL und erwartet 404 für die Demo-Personas", () => {
    for (const [schluessel, zeile] of Object.entries(MATRIX)) {
      if (!schluessel.includes(":")) continue;
      expect(zeile.url ?? zeile.urlJeAnfrage, schluessel).toBeDefined();
      expect(zeile.erwartet.demoAdmin, schluessel).toBe(404);
      expect(zeile.erwartet.demoEltern, schluessel).toBe(404);
    }
  });
});

describe("Sperre ohne zweiten Faktor (#23)", () => {
  // Bewusst eine Schleife: Jede künftige Admin-Route erbt die Regel; ein leeres test.each ergäbe gar keinen Test
  test("jede Admin-Route erwartet für «Admin ohne zweiten Faktor» 403", () => {
    let n = 0;
    for (const [schluessel, zeile] of Object.entries(MATRIX)) {
      if (!schluessel.split(" ")[1].startsWith("/api/v1/admin/")) continue;
      n++;
      expect(zeile.erwartet.adminOhneZweitenFaktor, schluessel).toBe(403);
    }
    expect(n).toBeGreaterThan(0);
  });

  test("der Admin ohne Faktor bekommt ZWEITER_FAKTOR_FEHLT, alle anderen den Status der Route", async () => {
    const anfrageAn = (persona: Persona) =>
      app.request("/api/v1/admin/personen", {
        headers: standard[persona].headers,
      });
    const ohne = await anfrageAn("adminOhneZweitenFaktor");
    expect(ohne.status).toBe(403);
    expect(await ohne.json()).toEqual({
      code: "ZWEITER_FAKTOR_FEHLT",
      message: "Für die Verwaltung braucht es zuerst einen zweiten Faktor.",
    });
    const eltern = await anfrageAn("elternA");
    expect(eltern.status).toBe(403);
    expect(await eltern.json()).toMatchObject({ code: "KEINE_BERECHTIGUNG" });
    expect((await anfrageAn("admin")).status).toBe(200);
  });
});

describe("Matrix: jede Route mal jede Persona", () => {
  test.each(Object.entries(MATRIX))("%s", async (schluessel, zeile) => {
    const [methode, pfad] = schluessel.split(" ");
    const eigene = zeile.frischePersonas ? await personasAnlegen() : standard;
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
      ...Object.fromEntries(
        Object.entries(welt).filter(([, v]) => typeof v === "string"),
      ),
      programmId,
      leitungProgrammId,
      patchZielId,
      startpasswortZielId,
      deaktivierenZielId,
      aktivierenZielId,
      patchStufeId,
      patchKindId,
      patchRegelId,
      bildZielId,
      elternAUserId: standard.elternA.id!,
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
      z.pfad = (await MATRIX[z.schluessel].urlJeAnfrage!()).replace(
        uuid,
        `{{ziel_${z.n}}}`,
      );
    }

    // Bodies, die von der Persona abhängen (eigene Stufe, Elternname), stehen als Variable body_<n> in deren Umgebung
    const bodyJePersona = (z: (typeof zeilen)[number], persona: Persona) => {
      const konto = standard[persona];
      const text = ersetze(JSON.stringify(MATRIX[z.schluessel].body!(konto)));
      return text
        .replaceAll(konto.benutzername ?? " ", "{{benutzername}}")
        .replaceAll(konto.passwort ?? " ", "{{passwort}}");
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
        werte[`ziel_${z.n}`] = uuid.exec(url)![0];
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
