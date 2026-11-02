import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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

const TAG = 86_400_000;

test("die CLI legt den Kantonsadmin an, und die Anmeldung mit dem Startpasswort gelingt", async () => {
  const benutzername = neuerBenutzername();
  const vorher = Date.now();
  const ergebnis = starte([
    "--benutzername",
    benutzername,
    "--name",
    "Testperson CLI",
  ]);
  expect(ergebnis.stderr).toBe("");
  expect(ergebnis.status).toBe(0);
  const zeilen = ergebnis.stdout.split("\n");
  expect(zeilen).toContain(`Kantonsadmin «${benutzername}» angelegt.`);
  expect(zeilen).toContain(
    "Nicht weiterleiten. Gilt 7 Tage und nur für die erste Anmeldung.",
  );
  const startpasswort = startpasswortAus(ergebnis.stdout);

  const [benutzer] = await benutzerMitNamen(benutzername);
  expect(benutzer.role).toBe("admin");
  expect(benutzer.mussPasswortAendern).toBe(true);
  expect(benutzer.fehlversuche).toBe(0);
  expect(benutzer.naechsterVersuchAb).toBeNull();
  // Ein Kantonsadmin hat keine Rolle in einer Einheit
  expect(
    await db
      .select()
      .from(schema.einheitRolle)
      .where(eq(schema.einheitRolle.userId, benutzer.id)),
  ).toEqual([]);
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
    einheitId: null,
    akteurId: "cli",
    aktion: "person_angelegt",
    zielTyp: "person",
    details: null,
  });

  expect(await meldeAn(benutzername, startpasswort)).toBe(benutzer.id);
});

test.each([
  ["mit «--passwort»", ["--passwort", "geheim"]],
  ["mit einem positionalen Argument", ["geheim"]],
  ["mit einer Abteilung", ["--abteilung", "Zweitabteilung"]],
  ["ohne Namen", []],
])(
  "ein Aufruf %s zeigt die Verwendung und legt nichts an",
  async (titel, zusatz) => {
    const benutzername = neuerBenutzername();
    const ergebnis = starte([
      ...(titel === "ohne Namen" ? [] : ["--name", "Testperson CLI"]),
      "--benutzername",
      benutzername,
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

test("ein zu kurzer Benutzername bricht ab, ohne etwas anzulegen", async () => {
  const ergebnis = starte(["--benutzername", "ab", "--name", "Testperson CLI"]);
  expect(ergebnis.status).toBe(1);
  expect(ergebnis.stderr).toContain("Admin nicht angelegt:");
  expect(ergebnis.stdout + ergebnis.stderr).not.toContain("Startpasswort:");
  expect(await benutzerMitNamen("ab")).toHaveLength(0);
});

test("ist HIBP nicht erreichbar, bleibt kein halber Benutzer und kein Audit-Eintrag zurück", async () => {
  const benutzername = neuerBenutzername();
  const ergebnis = starte(
    ["--benutzername", benutzername, "--name", "Testperson CLI"],
    { HIBP_ATTRAPPE: "fehler" },
  );
  expect(ergebnis.status).toBe(1);
  expect(ergebnis.stderr).toContain("Admin nicht angelegt:");
  expect(ergebnis.stdout + ergebnis.stderr).not.toContain("Startpasswort:");
  // createUser legt den User vor der HIBP-Prüfung an (#14); die Transaktion nimmt ihn samt Audit-Eintrag zurück
  expect(await benutzerMitNamen(benutzername)).toHaveLength(0);
});

test("«admin:anlegen» in package.json startet genau diese Datei", () => {
  const paket = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  expect(paket.scripts["admin:anlegen"]).toBe(
    "tsx --env-file-if-exists=.env src/cli/admin-anlegen.ts",
  );
});
