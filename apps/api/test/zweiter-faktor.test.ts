import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import { ladeSeiten } from "../src/seiten.js";
import {
  APP,
  bereiteAuthTestsVor,
  cookiesAus,
  erstelleTestAuth,
  zufallsIp,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  totpCode,
  type PersonaKonto,
  type Welt,
} from "./hilfen/personas.js";

bereiteAuthTestsVor();
// Jede Persona und jede Anmeldung rechnet scrypt
vi.setConfig({ hookTimeout: 120_000 });

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

let welt: Welt;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
});

type Kopfzeilen = Record<string, string>;

// Jede Anfrage mit eigener IP: Das Rate-Limit der Verify-Pfade (5 je 15 Minuten) gälte sonst für die ganze Datei
const kopf = (headers: Kopfzeilen) => ({
  ...headers,
  "content-type": "application/json",
  "x-forwarded-for": zufallsIp(),
});
const post = (pfad: string, headers: Kopfzeilen, body: object = {}) =>
  app.request(pfad, {
    method: "POST",
    headers: kopf(headers),
    body: JSON.stringify(body),
  });
const hole = (pfad: string, headers: Kopfzeilen) =>
  app.request(pfad, { method: "GET", headers: kopf(headers) });
const mitCookie = (cookie: string): Kopfzeilen => ({
  "expo-origin": APP,
  cookie,
});

const enable = (konto: PersonaKonto, headers = konto.headers) =>
  post("/api/auth/two-factor/enable", headers, { password: konto.passwort });

// Einrichten wie die App: enable, dann der erste Code; das neue Cookie ersetzt das alte
async function richteEin(konto: PersonaKonto, headers = konto.headers) {
  const einrichten = await enable(konto, headers);
  expect(einrichten.status).toBe(200);
  const daten = (await einrichten.json()) as {
    totpURI: string;
    backupCodes: string[];
  };
  const bestaetigt = await post("/api/auth/two-factor/verify-totp", headers, {
    code: await totpCode(welt, konto.id!),
  });
  expect(bestaetigt.status).toBe(200);
  return { ...daten, headers: mitCookie(cookiesAus(bestaetigt)) };
}

const neuerAdmin = () => legePersonaAn(welt, "kantonsadminOhneZweitenFaktor");

// Anmeldung am Router, wie die App
const meldeAn = (konto: PersonaKonto) =>
  post(
    "/api/auth/sign-in/username",
    { "expo-origin": APP },
    {
      username: konto.benutzername,
      password: konto.passwort,
    },
  );

describe("Einrichten", () => {
  test("der Link nennt «FireResponse» und den Benutzernamen, dazu zehn Ersatzcodes", async () => {
    const konto = await neuerAdmin();
    const antwort = await enable(konto);
    expect(antwort.status).toBe(200);
    const { totpURI, backupCodes, method } = await antwort.json();
    const schluessel = new URL(totpURI).searchParams.get("secret");
    expect(schluessel).toMatch(/^[A-Z2-7]+$/);
    expect(totpURI).toBe(
      `otpauth://totp/FireResponse:${konto.benutzername}?secret=${schluessel}&issuer=FireResponse&digits=6&period=30`,
    );
    // #11 legt Konten mit @example.org an: Die E-Mail-Adresse stünde mit %40 im Link
    expect(totpURI).not.toContain("%40");
    expect(method).toBe("totp");
    expect(backupCodes).toHaveLength(10);
    for (const code of backupCodes)
      expect(code).toMatch(/^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/);
  });

  test("method «otp» gibt es nicht: 400 OTP_NOT_CONFIGURED", async () => {
    const konto = await neuerAdmin();
    const antwort = await post("/api/auth/two-factor/enable", konto.headers, {
      password: konto.passwort,
      method: "otp",
    });
    expect(antwort.status).toBe(400);
    expect(await antwort.json()).toMatchObject({ code: "OTP_NOT_CONFIGURED" });
  });

  test("bei aktivem Faktor gibt enable 400 TOTP_ALREADY_ENABLED", async () => {
    const konto = await neuerAdmin();
    const { headers } = await richteEin(konto);
    const antwort = await enable(konto, headers);
    expect(antwort.status).toBe(400);
    expect(await antwort.json()).toMatchObject({
      code: "TOTP_ALREADY_ENABLED",
    });
  });

  test("zweiterFaktor wechselt in GET /ich von false auf true, ohne Geheimnisse", async () => {
    const konto = await neuerAdmin();
    const lesen = async (headers: Kopfzeilen) =>
      (await hole("/api/v1/ich", headers)).json();
    const vorher = await lesen(konto.headers);
    expect(vorher.zweiterFaktor).toBe(false);

    const { headers } = await richteEin(konto);
    const nachher = await lesen(headers);
    expect(nachher.zweiterFaktor).toBe(true);
    expect(JSON.stringify(nachher)).not.toMatch(
      /secret|backup|verified|locked|failedVerification|totp/i,
    );
  });

  test("die Admin-Routen antworten bis zum ersten Code 403 ZWEITER_FAKTOR_FEHLT, danach 200", async () => {
    const konto = await neuerAdmin();
    const gesperrt = await hole("/api/v1/admin/system", konto.headers);
    expect(gesperrt.status).toBe(403);
    expect(await gesperrt.json()).toEqual({
      code: "ZWEITER_FAKTOR_FEHLT",
      message: "Für die Verwaltung braucht es zuerst einen zweiten Faktor.",
    });
    // enable allein schaltet nichts ein
    await enable(konto);
    expect((await hole("/api/v1/admin/system", konto.headers)).status).toBe(
      403,
    );
    const bestaetigt = await post(
      "/api/auth/two-factor/verify-totp",
      konto.headers,
      { code: await totpCode(welt, konto.id!) },
    );
    expect(bestaetigt.status).toBe(200);
    expect(
      (await hole("/api/v1/admin/system", mitCookie(cookiesAus(bestaetigt))))
        .status,
    ).toBe(200);
  });

  test("die Aktivierung beendet die anderen Sitzungen; das neue Cookie gilt", async () => {
    const konto = await neuerAdmin();
    // Ein zweites Gerät, ohne Code angemeldet
    const zweites = mitCookie(
      cookiesAus(
        await auth.api.signInUsername({
          body: { username: konto.benutzername!, password: konto.passwort! },
          returnHeaders: true,
        }),
      ),
    );
    expect((await hole("/api/v1/ich", zweites)).status).toBe(200);
    const { headers } = await richteEin(konto);
    expect((await hole("/api/v1/ich", zweites)).status).toBe(401);
    expect((await hole("/api/v1/ich", konto.headers)).status).toBe(401);
    expect((await hole("/api/v1/ich", headers)).status).toBe(200);
  });
});

describe("Anmeldung mit dem zweiten Faktor", () => {
  test("sign-in/username gibt twoFactorRedirect ohne Sitzungs-Cookie; verify-totp meldet an", async () => {
    const konto = await neuerAdmin();
    await richteEin(konto);
    const anmeldung = await meldeAn(konto);
    expect(anmeldung.status).toBe(200);
    expect(await anmeldung.json()).toEqual({
      twoFactorRedirect: true,
      twoFactorMethods: ["totp"],
    });
    const zwischen = cookiesAus(anmeldung);
    expect(zwischen).not.toContain("session_token");
    const antwort = await post(
      "/api/auth/two-factor/verify-totp",
      mitCookie(zwischen),
      {
        code: await totpCode(welt, konto.id!),
      },
    );
    expect(antwort.status).toBe(200);
    const sitzung = mitCookie(cookiesAus(antwort));
    expect((await hole("/api/v1/ich", sitzung)).status).toBe(200);
    expect((await hole("/api/v1/admin/system", sitzung)).status).toBe(200);
  });

  test("ein falscher Code gibt 401 INVALID_CODE und keine Sitzung", async () => {
    const konto = await neuerAdmin();
    await richteEin(konto);
    const zwischen = cookiesAus(await meldeAn(konto));
    const antwort = await post(
      "/api/auth/two-factor/verify-totp",
      mitCookie(zwischen),
      {
        code: "000000",
      },
    );
    expect(antwort.status).toBe(401);
    expect(await antwort.json()).toMatchObject({ code: "INVALID_CODE" });
    expect(cookiesAus(antwort)).not.toContain("session_token");
  });

  test("ein Ersatzcode meldet an und gilt einmal: derselbe nochmals gibt 401 INVALID_BACKUP_CODE", async () => {
    const konto = await neuerAdmin();
    const { backupCodes } = await richteEin(konto);
    const mitErsatzcode = async () =>
      post(
        "/api/auth/two-factor/verify-backup-code",
        mitCookie(cookiesAus(await meldeAn(konto))),
        { code: backupCodes[0] },
      );
    const erste = await mitErsatzcode();
    expect(erste.status).toBe(200);
    expect(
      (await hole("/api/v1/ich", mitCookie(cookiesAus(erste)))).status,
    ).toBe(200);
    const zweite = await mitErsatzcode();
    expect(zweite.status).toBe(401);
    expect(await zweite.json()).toMatchObject({ code: "INVALID_BACKUP_CODE" });
  });

  test.each(["verify-totp", "verify-backup-code"] as const)(
    "%s ignoriert trustDevice, Der nächste Login fragt wieder nach dem Code",
    async (pfad) => {
      const konto = await neuerAdmin();
      const { backupCodes } = await richteEin(konto);
      const code = async () =>
        pfad === "verify-totp"
          ? await totpCode(welt, konto.id!)
          : backupCodes[backupCodes.length - 1];
      const zwischen = cookiesAus(await meldeAn(konto));
      const antwort = await post(
        `/api/auth/two-factor/${pfad}`,
        mitCookie(zwischen),
        { code: await code(), trustDevice: true },
      );
      expect(antwort.status).toBe(200);
      expect(cookiesAus(antwort)).not.toContain("trust_device");
      // Mit dem Cookie-Speicher dieses Geräts: Ohne trust_device-Cookie fragt auch die nächste Anmeldung nach dem Code
      const naechste = await post(
        "/api/auth/sign-in/username",
        mitCookie(cookiesAus(antwort)),
        {
          username: konto.benutzername,
          password: konto.passwort,
        },
      );
      expect(await naechste.json()).toMatchObject({ twoFactorRedirect: true });
    },
  );
});
