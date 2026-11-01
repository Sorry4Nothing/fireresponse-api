import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { bereiteAuthTestsVor, erstelleTestAuth } from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  type PersonaKonto,
} from "./hilfen/personas.js";

bereiteAuthTestsVor();
// Ein CLI-Start (bis 60 s) je Test
vi.setConfig({ testTimeout: 180_000 });

const db = erstelleDb(postgres(API_URL));
const auth = erstelleTestAuth(db);
afterAll(() => db.$client.end());

let abteilungId: string;
let mitFaktor: PersonaKonto;
let ohneFaktor: PersonaKonto;
beforeAll(async () => {
  const welt = await erstelleWelt(db, auth);
  abteilungId = welt.testabteilungId;
  mitFaktor = await legePersonaAn(welt, "admin");
  ohneFaktor = await legePersonaAn(welt, "adminOhneZweitenFaktor");
});

// Direkt die Datei statt npm run (kein npm.cmd-Umweg, wie #73); die CLI ruft better-auth nie auf, darum ohne HIBP-Attrappe
function starte(argumente: string[]) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli/zweiter-faktor-zuruecksetzen.ts",
      ...argumente,
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, DATABASE_URL: API_URL },
      encoding: "utf8",
      // Auf einem ausgelasteten Rechner startet tsx ein Vielfaches langsamer
      timeout: 60_000,
    },
  );
}

const faktorZeilen = (id: string) =>
  db.select().from(schema.twoFactor).where(eq(schema.twoFactor.userId, id));
const auditZeilen = (zielId: string) =>
  db.select().from(schema.auditLog).where(eq(schema.auditLog.zielId, zielId));

test("mit Faktor: Exit 0, Zeilen weg, Flag aus, Audit-Zeile «cli»", async () => {
  expect(await faktorZeilen(mitFaktor.id!)).toHaveLength(1);
  const ergebnis = starte([
    "--benutzername",
    // Gross geschrieben: Die CLI sucht kleingeschrieben, wie das Plugin speichert
    ` ${mitFaktor.benutzername!.toUpperCase()} `,
  ]);
  expect(ergebnis.stderr).toBe("");
  expect(ergebnis.status).toBe(0);
  expect(ergebnis.stdout).toBe(
    `Zweiter Faktor von «${mitFaktor.benutzername}» zurückgesetzt. Die Person meldet sich ohne Code an und richtet ihn in der App neu ein.\n`,
  );
  expect(await faktorZeilen(mitFaktor.id!)).toEqual([]);
  const [zeile] = await db
    .select({ an: schema.user.twoFactorEnabled })
    .from(schema.user)
    .where(eq(schema.user.id, mitFaktor.id!));
  expect(zeile.an).toBe(false);
  const audit = await auditZeilen(mitFaktor.id!);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({
    abteilungId,
    akteurId: "cli",
    aktion: "zweiter_faktor_zurueckgesetzt",
    zielTyp: "person",
    details: null,
  });
  // Die Anmeldung geht ohne Code
  const anmeldung = await auth.api.signInUsername({
    body: { username: mitFaktor.benutzername!, password: mitFaktor.passwort! },
  });
  expect(anmeldung).not.toHaveProperty("twoFactorRedirect");
});

test("unbekannter Benutzername: Exit 1 mit Meldung", () => {
  const ergebnis = starte(["--benutzername", "gibt.es.nicht"]);
  expect(ergebnis.status).toBe(1);
  expect(ergebnis.stdout).toBe("");
  expect(ergebnis.stderr).toBe(
    "Keine Person mit dem Benutzernamen «gibt.es.nicht».\n",
  );
});

test("ohne Faktor: Exit 1, nichts geschrieben", async () => {
  const ergebnis = starte(["--benutzername", ohneFaktor.benutzername!]);
  expect(ergebnis.status).toBe(1);
  expect(ergebnis.stderr).toBe(
    `«${ohneFaktor.benutzername}» hat keinen zweiten Faktor.\n`,
  );
  expect(await auditZeilen(ohneFaktor.id!)).toEqual([]);
});

test.each([
  ["ein unbekannter Schalter", ["--passwort", "geheim-1234"]],
  ["ein positionales Argument", ["geheim-1234"]],
  ["kein Schalter", []],
  ["ein leerer Name", ["--benutzername", "  "]],
])(
  "%s: Exit 1 mit der Verwendung, ohne die Eingabe zu wiederholen",
  (_, argumente) => {
    const ergebnis = starte(argumente);
    expect(ergebnis.status).toBe(1);
    expect(ergebnis.stdout).toBe("");
    expect(ergebnis.stderr).toBe(
      "Verwendung: npm run zweiter-faktor:zuruecksetzen -w apps/api -- --benutzername <benutzername>\n",
    );
  },
);

test("«zweiter-faktor:zuruecksetzen» in package.json startet genau diese Datei", () => {
  const paket = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  expect(paket.scripts["zweiter-faktor:zuruecksetzen"]).toBe(
    "tsx --env-file-if-exists=.env src/cli/zweiter-faktor-zuruecksetzen.ts",
  );
});
