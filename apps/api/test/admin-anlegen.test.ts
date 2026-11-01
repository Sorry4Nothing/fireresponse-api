import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, expect, test, vi } from "vitest";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import {
  APP,
  bereiteAuthTestsVor,
  cookiesAus,
  erstelleTestAuth,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";

bereiteAuthTestsVor();
// Bis zu zwei CLI-Starts (je bis 60 s) plus eine scrypt-Anmeldung pro Test (#8: unter Last bis 19 s)
vi.setConfig({ testTimeout: 180_000 });

const db = erstelleDb(postgres(API_URL));
const auth = erstelleTestAuth(db);
afterAll(() => db.$client.end());

// Erfundene Werte für jede Pflichtvariable; nur DATABASE_URL zählt für die CLI
const UMGEBUNG = {
  ...process.env,
  DATABASE_URL: API_URL,
  APP_MIN_VERSION: "0.1.0",
  PORT: "4020",
  BETTER_AUTH_SECRET: "nur-fuer-tests-0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:4020",
};

// Direkt die Datei statt npm run (kein npm.cmd-Umweg, wie #73); die Attrappe ersetzt fetch im Kindprozess
function starte(argumente: string[], umgebung: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./test/hilfen/hibp-attrappe.ts",
      "src/cli/admin-anlegen.ts",
      ...argumente,
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...UMGEBUNG, ...umgebung },
      encoding: "utf8",
      // Auf einem ausgelasteten Rechner startet tsx ein Vielfaches langsamer
      timeout: 60_000,
    },
  );
}

// Kein randomUUID für den Benutzernamen: Der Standard-Validator lässt «-» nicht zu (#18 erweitert ihn erst)
const neuerBenutzername = () => `cli.${randomBytes(4).toString("hex")}`;
// Nie «Testabteilung»: Die gibt es pro Testdatei, die Suche nach dem Namen wäre mehrdeutig
const neuerAbteilungsname = () => `Testabteilung CLI ${randomUUID()}`;

function startpasswortAus(stdout: string) {
  const zeilen = stdout
    .split("\n")
    .filter((zeile) => zeile.startsWith("Startpasswort: "));
  expect(zeilen).toHaveLength(1);
  const passwort = zeilen[0].slice("Startpasswort: ".length);
  // Genau die Form und das Alphabet von erzeugeStartpasswort (#15)
  expect(passwort).toMatch(
    /^[23456789ACDEFGHJKMNPQRTUVWXY]{4}(-[23456789ACDEFGHJKMNPQRTUVWXY]{4}){2}$/,
  );
  return passwort;
}

// Anmeldung wie der Expo-Client, über auth.api: Hooks laufen, Router-Rate-Limit nicht
async function meldeAn(benutzername: string, passwort: string) {
  const anmeldung = await auth.api.signInUsername({
    body: { username: benutzername, password: passwort },
    returnHeaders: true,
  });
  const sitzung = await auth.api.getSession({
    headers: { "expo-origin": APP, cookie: cookiesAus(anmeldung) },
  });
  return sitzung?.user.id;
}

async function benutzerMitNamen(benutzername: string) {
  return db
    .select()
    .from(schema.user)
    .where(eq(schema.user.username, benutzername));
}

// Fall B und D2 bauen auf der Abteilung aus Fall A auf
let abteilungA: { name: string; id: string };

const TAG = 86_400_000;

test("die CLI legt Abteilung und Admin an, und die Anmeldung mit dem Startpasswort gelingt", async () => {
  const benutzername = neuerBenutzername();
  const abteilungsname = neuerAbteilungsname();
  const vorher = Date.now();
  const ergebnis = starte([
    "--benutzername",
    benutzername,
    "--name",
    "Testperson CLI",
    "--neue-abteilung",
    abteilungsname,
  ]);
  expect(ergebnis.stderr).toBe("");
  expect(ergebnis.status).toBe(0);
  const zeilen = ergebnis.stdout.split("\n");
  expect(zeilen).toContain(`Abteilung «${abteilungsname}» angelegt.`);
  expect(zeilen).toContain(`Admin «${benutzername}» angelegt.`);
  expect(zeilen).toContain(
    "Nicht weiterleiten. Gilt 7 Tage und nur für die erste Anmeldung.",
  );
  const startpasswort = startpasswortAus(ergebnis.stdout);

  const [abteilung] = await db
    .select()
    .from(schema.abteilung)
    .where(eq(schema.abteilung.name, abteilungsname));
  abteilungA = { name: abteilungsname, id: abteilung.id };

  const [benutzer] = await benutzerMitNamen(benutzername);
  expect(benutzer.role).toBe("admin");
  expect(benutzer.abteilungId).toBe(abteilung.id);
  expect(benutzer.mussPasswortAendern).toBe(true);
  expect(benutzer.fehlversuche).toBe(0);
  expect(benutzer.naechsterVersuchAb).toBeNull();
  // Gültig bis rund 7 Tage nach dem Anlegen; die CLI lief zwischen vorher und jetzt
  const gueltigBis = benutzer.startpasswortGueltigBis!.getTime();
  expect(gueltigBis).toBeGreaterThanOrEqual(vorher + 7 * TAG);
  expect(gueltigBis).toBeLessThanOrEqual(Date.now() + 7 * TAG);

  // Gespeichert ist nur der Hash, weder die gedruckte noch die normalisierte Form
  const [konto] = await db
    .select()
    .from(schema.account)
    .where(eq(schema.account.userId, benutzer.id));
  expect(konto.password).not.toContain(startpasswort);
  expect(konto.password).not.toContain(startpasswort.replaceAll("-", ""));

  const protokoll = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.zielId, benutzer.id));
  expect(protokoll).toHaveLength(1);
  expect(protokoll[0]).toMatchObject({
    abteilungId: abteilung.id,
    akteurId: "cli",
    aktion: "person_angelegt",
    zielTyp: "person",
    details: null,
  });

  expect(await meldeAn(benutzername, startpasswort)).toBe(benutzer.id);
});

test("die CLI legt in einer bestehenden Abteilung einen weiteren Admin an, auch wenn es schon welche gibt", async () => {
  const benutzername = neuerBenutzername();
  const ergebnis = starte([
    "--benutzername",
    benutzername,
    "--name",
    "Testperson CLI",
    "--abteilung",
    abteilungA.name,
  ]);
  expect(ergebnis.stderr).toBe("");
  expect(ergebnis.status).toBe(0);
  const startpasswort = startpasswortAus(ergebnis.stdout);
  const [benutzer] = await benutzerMitNamen(benutzername);
  expect(benutzer.role).toBe("admin");
  expect(benutzer.abteilungId).toBe(abteilungA.id);
  expect(await meldeAn(benutzername, startpasswort)).toBe(benutzer.id);
});

test.each([
  ["mit «--passwort»", ["--passwort", "geheim"]],
  ["mit einem positionalen Argument", ["geheim"]],
  ["mit beiden Abteilungs-Flags", ["--abteilung", "Zweitabteilung"]],
])(
  "ein Aufruf %s zeigt die Verwendung und legt nichts an",
  async (_titel, zusatz) => {
    const benutzername = neuerBenutzername();
    const ergebnis = starte([
      "--benutzername",
      benutzername,
      "--name",
      "Testperson CLI",
      "--neue-abteilung",
      neuerAbteilungsname(),
      ...zusatz,
    ]);
    expect(ergebnis.status).toBe(1);
    expect(ergebnis.stderr).toContain("Verwendung:");
    // Kein Startpasswort und nie das abgefangene Argument, in keinem der beiden Ströme
    expect(ergebnis.stdout + ergebnis.stderr).not.toContain("Startpasswort:");
    expect(ergebnis.stdout + ergebnis.stderr).not.toContain("geheim");
    expect(await benutzerMitNamen(benutzername)).toHaveLength(0);
  },
);

test("eine unbekannte Abteilung bricht ab, ohne etwas anzulegen", async () => {
  const benutzername = neuerBenutzername();
  const abteilungsname = neuerAbteilungsname();
  const ergebnis = starte([
    "--benutzername",
    benutzername,
    "--name",
    "Testperson CLI",
    "--abteilung",
    abteilungsname,
  ]);
  expect(ergebnis.status).toBe(1);
  expect(ergebnis.stderr).toContain(
    `Admin nicht angelegt: Keine eindeutige Abteilung «${abteilungsname}».`,
  );
  expect(await benutzerMitNamen(benutzername)).toHaveLength(0);
});

test("eine schon vorhandene Abteilung bricht «--neue-abteilung» ab", async () => {
  const benutzername = neuerBenutzername();
  const ergebnis = starte([
    "--benutzername",
    benutzername,
    "--name",
    "Testperson CLI",
    "--neue-abteilung",
    abteilungA.name,
  ]);
  expect(ergebnis.status).toBe(1);
  expect(ergebnis.stderr).toContain(
    `Admin nicht angelegt: Abteilung «${abteilungA.name}» gibt es schon.`,
  );
  expect(await benutzerMitNamen(benutzername)).toHaveLength(0);
  // Die Abteilung aus dem ersten Test bleibt die einzige mit diesem Namen
  const abteilungen = await db
    .select()
    .from(schema.abteilung)
    .where(eq(schema.abteilung.name, abteilungA.name));
  expect(abteilungen).toHaveLength(1);
});

test("ist HIBP nicht erreichbar, bleibt kein halber Benutzer und kein Audit-Eintrag zurück", async () => {
  const benutzername = neuerBenutzername();
  const abteilungsname = neuerAbteilungsname();
  const [abteilung] = await db
    .insert(schema.abteilung)
    .values({ name: abteilungsname })
    .returning();
  const ergebnis = starte(
    [
      "--benutzername",
      benutzername,
      "--name",
      "Testperson CLI",
      "--abteilung",
      abteilungsname,
    ],
    { HIBP_ATTRAPPE: "fehler" },
  );
  expect(ergebnis.status).toBe(1);
  expect(ergebnis.stderr).toContain("Admin nicht angelegt:");
  expect(ergebnis.stdout + ergebnis.stderr).not.toContain("Startpasswort:");
  // createUser legt den User vor der HIBP-Prüfung an (#14); die Transaktion nimmt ihn samt Audit-Eintrag zurück
  expect(await benutzerMitNamen(benutzername)).toHaveLength(0);
  const protokoll = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.abteilungId, abteilung.id));
  expect(protokoll).toHaveLength(0);
});

test("ist HIBP nicht erreichbar, entsteht auch keine neue Abteilung", async () => {
  const abteilungsname = neuerAbteilungsname();
  const ergebnis = starte(
    [
      "--benutzername",
      neuerBenutzername(),
      "--name",
      "Testperson CLI",
      "--neue-abteilung",
      abteilungsname,
    ],
    { HIBP_ATTRAPPE: "fehler" },
  );
  expect(ergebnis.status).toBe(1);
  const abteilungen = await db
    .select()
    .from(schema.abteilung)
    .where(eq(schema.abteilung.name, abteilungsname));
  expect(abteilungen).toHaveLength(0);
});

test("«admin:anlegen» in package.json startet genau diese Datei", () => {
  const paket = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  expect(paket.scripts["admin:anlegen"]).toBe(
    "tsx --env-file-if-exists=.env src/cli/admin-anlegen.ts",
  );
});
