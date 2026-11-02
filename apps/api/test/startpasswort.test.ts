import { randomUUID } from "node:crypto";
import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";
import { expect, test } from "vitest";
import { erstelleAuth, platzhalterEmail } from "../src/auth.js";
import {
  entschluesseleStartpasswort,
  erzeugeStartpasswort,
  normalisiereStartpasswort,
  verschluesseleStartpasswort,
  startpasswortFelder,
} from "../src/startpasswort.js";
import { bereiteAuthTestsVor } from "./hilfen/auth.js";

bereiteAuthTestsVor();

// Die 28 Zeichen ohne 0, O, 1, I, L, B, S, Z
const ALPHABET = "23456789ACDEFGHJKMNPQRTUVWXY";
const GRUPPE = `[${ALPHABET}]{4}`;
const MUSTER = new RegExp(`^${GRUPPE}-${GRUPPE}-${GRUPPE}$`);
const TAG = 86_400_000;

test("1000 Startpasswörter: Format 4-4-4, nur Zeichen aus dem Alphabet, und alle 28 kommen vor", () => {
  const gezogen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const passwort = erzeugeStartpasswort();
    expect(passwort).toMatch(MUSTER);
    for (const zeichen of passwort.replaceAll("-", "")) gezogen.add(zeichen);
  }
  expect([...gezogen].sort().join("")).toBe(ALPHABET);
});

test("12 Zeichen aus 28 ergeben rund 58 Bit", () => {
  // Aus einer echten Ziehung abgeleitet: ändert sich Länge oder Alphabet, wird der Test rot
  const laenge = erzeugeStartpasswort().replaceAll("-", "").length;
  const bits = laenge * Math.log2(ALPHABET.length);
  expect(bits).toBeGreaterThan(57.5);
  expect(bits).toBeLessThan(58.5);
});

test("normalisieren: ohne Bindestriche und Leerzeichen, in Grossbuchstaben", () => {
  expect(normalisiereStartpasswort("k7mp q4xr-t9wd")).toBe("K7MPQ4XRT9WD");
  expect(normalisiereStartpasswort(" K7MP\tQ4XR\nT9WD ")).toBe("K7MPQ4XRT9WD");
  expect(normalisiereStartpasswort(erzeugeStartpasswort())).toMatch(
    new RegExp(`^[${ALPHABET}]{12}$`),
  );
});

test("startpasswortFelder: Pflichtwechsel an, 7 Tage gültig, Bremse zurück", () => {
  const jetzt = new Date("2026-10-26T12:00:00Z");
  expect(startpasswortFelder(jetzt)).toEqual({
    mussPasswortAendern: true,
    startpasswortGueltigBis: new Date("2026-11-02T12:00:00Z"),
    startpasswortVerschluesselt: null,
    fehlversuche: 0,
    naechsterVersuchAb: null,
  });
  // Ohne Argument gilt jetzt
  const abstand =
    startpasswortFelder().startpasswortGueltigBis.getTime() - Date.now();
  expect(abstand).toBeGreaterThan(7 * TAG - 60_000);
  expect(abstand).toBeLessThanOrEqual(7 * TAG);
});

test("gespeichert wird nur der Hash, nie das Startpasswort", async () => {
  const db: MemoryDB = {
    user: [],
    session: [],
    account: [],
    verification: [],
    twoFactor: [],
    rateLimit: [],
  };
  const auth = erstelleAuth(memoryAdapter(db));
  const startpasswort = erzeugeStartpasswort();
  await auth.api.createUser({
    body: {
      email: `${randomUUID()}@example.org`,
      password: normalisiereStartpasswort(startpasswort),
      name: "Testperson",
      data: { username: "startperson", ...startpasswortFelder() },
    },
  });
  const [konto] = db.account;
  expect(konto.password).not.toContain(startpasswort);
  expect(konto.password).not.toContain(
    normalisiereStartpasswort(startpasswort),
  );
  // scrypt-Format von better-auth: Salz und Schlüssel, hexkodiert
  expect(konto.password).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
});

test("platzhalterEmail: zufällige UUID vor @benutzer.invalid, nie zweimal gleich", () => {
  const eine = platzhalterEmail();
  expect(eine).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@benutzer\.invalid$/,
  );
  expect(platzhalterEmail()).not.toBe(eine);
});

test("Startpasswort: verschlüsseln und entschlüsseln; Fremdes und Leeres ergeben null", () => {
  const klar = erzeugeStartpasswort();
  const chiffre = verschluesseleStartpasswort(klar);
  expect(chiffre).not.toContain(klar);
  expect(entschluesseleStartpasswort(chiffre)).toBe(klar);
  // Jede Ablage hat einen eigenen IV
  expect(verschluesseleStartpasswort(klar)).not.toBe(chiffre);
  expect(entschluesseleStartpasswort(null)).toBeNull();
  expect(entschluesseleStartpasswort("kaputt")).toBeNull();
  expect(entschluesseleStartpasswort(chiffre.slice(0, -2) + "AA")).toBeNull();
});
