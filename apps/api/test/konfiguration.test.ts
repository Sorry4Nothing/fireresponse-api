import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { ladeKonfiguration } from "../src/konfiguration.js";

// Erfundene Werte; was eine Variable enthält, darf nie in der Meldung stehen
const GUELTIG = {
  DATABASE_URL: "postgres://api:geheim-1@db.example.org:5432/fireresponse",
  APP_MIN_VERSION: "0.1.0",
  PORT: "3000",
  BETTER_AUTH_SECRET: "geheim-6-0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
};
const UNGUELTIG = {
  DATABASE_URL: [
    "mysql://api:geheim-2@db.example.org/fireresponse",
    "geheim-3",
  ],
  APP_MIN_VERSION: ["1.2", "1.2.0-beta", "geheim-4"],
  PORT: ["0", "65536", "30.5", "-1.5", "geheim-5"],
  // Unter 32 Zeichen
  BETTER_AUTH_SECRET: ["geheim-7"],
  BETTER_AUTH_URL: ["ftp://api.example.org", "geheim-8"],
};

function meldung(env: Record<string, string | undefined>) {
  try {
    ladeKonfiguration(env);
  } catch (fehler) {
    return (fehler as Error).message;
  }
  throw new Error("ladeKonfiguration hat nicht geworfen");
}

test("liest die Werte und übergeht andere Variablen", () => {
  expect(ladeKonfiguration({ ...GUELTIG, HOME: "/home/benutzer" })).toEqual({
    DATABASE_URL: GUELTIG.DATABASE_URL,
    APP_MIN_VERSION: "0.1.0",
    PORT: 3000,
    BETTER_AUTH_SECRET: GUELTIG.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: "http://localhost:3000",
  });
});

describe.each(Object.keys(UNGUELTIG) as (keyof typeof UNGUELTIG)[])(
  "%s",
  (name) => {
    test.each<[string, string | undefined]>([
      ["fehlt", undefined],
      ["ist leer", ""],
      ...UNGUELTIG[name].map((wert): [string, string] => [
        `ist «${wert}»`,
        wert,
      ]),
    ])("%s: Die Meldung nennt nur den Namen", (_, wert) => {
      expect(meldung({ ...GUELTIG, [name]: wert })).toBe(
        `Fehlende oder ungültige Umgebungsvariablen: ${name}`,
      );
    });
  },
);

test("BETTER_AUTH_URL mit http: in Produktion ein Fehler, sonst erlaubt (#222)", () => {
  expect(meldung({ ...GUELTIG, NODE_ENV: "production" })).toBe(
    "Fehlende oder ungültige Umgebungsvariablen: BETTER_AUTH_URL",
  );
  expect(
    ladeKonfiguration({
      ...GUELTIG,
      NODE_ENV: "production",
      BETTER_AUTH_URL: "https://api.example.org",
    }).BETTER_AUTH_URL,
  ).toBe("https://api.example.org");
  expect(
    ladeKonfiguration({ ...GUELTIG, NODE_ENV: "development" }).BETTER_AUTH_URL,
  ).toBe("http://localhost:3000");
});

test("ohne Konfiguration nennt die Meldung alle fünf Namen", () => {
  expect(meldung({})).toBe(
    "Fehlende oder ungültige Umgebungsvariablen: DATABASE_URL, APP_MIN_VERSION, PORT, BETTER_AUTH_SECRET, BETTER_AUTH_URL",
  );
});

test("der Server startet ohne Konfiguration nicht", () => {
  const ergebnis = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/server.ts"],
    {
      cwd: new URL("..", import.meta.url),
      // Die Umgebung kann DATABASE_URL setzen; Schlüssel mit undefined lässt Node weg
      env: {
        ...process.env,
        DATABASE_URL: undefined,
        APP_MIN_VERSION: undefined,
        PORT: undefined,
        BETTER_AUTH_SECRET: undefined,
        BETTER_AUTH_URL: undefined,
      },
      encoding: "utf8",
      // Auf einem ausgelasteten Rechner dauert der Start mit tsx ein Vielfaches
      timeout: 60_000,
    },
  );
  expect(ergebnis.status).toBe(1);
  expect(ergebnis.stderr).toContain(
    "Fehlende oder ungültige Umgebungsvariablen: DATABASE_URL, APP_MIN_VERSION, PORT, BETTER_AUTH_SECRET, BETTER_AUTH_URL",
  );
}, 70_000);

test("FCM_SCHLUESSEL_DATEI ist freiwillig und wird durchgereicht", () => {
  expect(ladeKonfiguration(GUELTIG).FCM_SCHLUESSEL_DATEI).toBeUndefined();
  expect(
    ladeKonfiguration({ ...GUELTIG, FCM_SCHLUESSEL_DATEI: "/pfad/fcm.json" })
      .FCM_SCHLUESSEL_DATEI,
  ).toBe("/pfad/fcm.json");
  expect(meldung({ ...GUELTIG, FCM_SCHLUESSEL_DATEI: "" })).toBe(
    "Fehlende oder ungültige Umgebungsvariablen: FCM_SCHLUESSEL_DATEI",
  );
});

test("VERANTWORTLICHE_STELLE und KONTAKT_EMAIL sind freiwillig und müssen gültig sein", () => {
  const leer = ladeKonfiguration(GUELTIG);
  expect(leer.VERANTWORTLICHE_STELLE).toBeUndefined();
  expect(leer.KONTAKT_EMAIL).toBeUndefined();
  const mit = ladeKonfiguration({
    ...GUELTIG,
    VERANTWORTLICHE_STELLE: "Verein Beispiel",
    KONTAKT_EMAIL: "kontakt@example.org",
  });
  expect(mit.VERANTWORTLICHE_STELLE).toBe("Verein Beispiel");
  expect(mit.KONTAKT_EMAIL).toBe("kontakt@example.org");
  expect(meldung({ ...GUELTIG, KONTAKT_EMAIL: "keine-adresse" })).toBe(
    "Fehlende oder ungültige Umgebungsvariablen: KONTAKT_EMAIL",
  );
  expect(meldung({ ...GUELTIG, VERANTWORTLICHE_STELLE: "  " })).toBe(
    "Fehlende oder ungültige Umgebungsvariablen: VERANTWORTLICHE_STELLE",
  );
});
