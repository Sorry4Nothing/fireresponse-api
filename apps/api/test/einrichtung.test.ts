import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, expect, test, vi } from "vitest";
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { ladeSeiten } from "../src/seiten.js";
import {
  APP,
  bereiteAuthTestsVor,
  cookiesAus,
  erstelleTestAuth,
  zufallsIp,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import { totpCode, type Welt } from "./hilfen/personas.js";

bereiteAuthTestsVor();
// Ein CLI-Start (bis 60 s) plus rund ein Dutzend scrypt-Anmeldungen und Kontenanlagen in einem Test
vi.setConfig({ testTimeout: 300_000 });

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

// Die Teile von Welt, die totpCode braucht
const welt = { auth, db } as Welt;

const UMGEBUNG = {
  ...process.env,
  DATABASE_URL: API_URL,
  APP_MIN_VERSION: "0.1.0",
  PORT: "4021",
  BETTER_AUTH_SECRET: "nur-fuer-tests-0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:4021",
};

// Der Weg eines Servers ohne Konto: die CLI ist der einzige Einstieg
function legeKantonsadminAn(benutzername: string) {
  const ergebnis = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./test/hilfen/hibp-attrappe.ts",
      "src/cli/kantonsadmin-anlegen.ts",
      "--benutzername",
      benutzername,
      "--name",
      "Erste Kantonsadmin",
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: UMGEBUNG,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  expect(ergebnis.stderr).toBe("");
  expect(ergebnis.status).toBe(0);
  const zeile = ergebnis.stdout
    .split("\n")
    .find((z) => z.startsWith("Startpasswort: "));
  return zeile!.slice("Startpasswort: ".length);
}

type Kopf = Record<string, string>;
const kopf = (cookie = ""): Kopf => ({
  "expo-origin": APP,
  "content-type": "application/json",
  "x-forwarded-for": zufallsIp(),
  ...(cookie && { cookie }),
});
const sende = (cookie: string, methode: string, pfad: string, body?: unknown) =>
  app.request(pfad, {
    method: methode,
    headers: kopf(cookie),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// Ein Konto, das sich anmeldet: Cookie und Passwort wandern mit
interface Sitzung {
  id: string;
  benutzername: string;
  passwort: string;
  cookie: string;
}

async function meldeAn(
  benutzername: string,
  passwort: string,
  mitFaktor = false,
): Promise<Sitzung> {
  const anmeldung = await sende("", "POST", "/api/auth/sign-in/username", {
    username: benutzername,
    password: passwort,
  });
  expect(anmeldung.status, `Anmeldung ${benutzername}`).toBe(200);
  let cookie = cookiesAus(anmeldung);
  const daten = await anmeldung.json();
  if (mitFaktor) {
    expect(daten.twoFactorRedirect).toBe(true);
    const [{ id }] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.username, benutzername));
    const geprueft = await sende(
      cookie,
      "POST",
      "/api/auth/two-factor/verify-totp",
      {
        code: await totpCode(welt, id),
      },
    );
    expect(geprueft.status).toBe(200);
    cookie = cookiesAus(geprueft);
  } else {
    expect(daten.twoFactorRedirect).toBeUndefined();
  }
  const profil = await (await sende(cookie, "GET", "/api/v1/ich")).json();
  return { id: profil.id, benutzername, passwort, cookie };
}

// Der Pflichtwechsel: bis dahin sperrt die API alles ausser dem eigenen Profil
async function ersetzeStartpasswort(sitzung: Sitzung): Promise<Sitzung> {
  const gesperrt = await sende(sitzung.cookie, "GET", "/api/v1/einwilligung");
  expect(gesperrt.status).toBe(403);
  const neu = `neu-${randomBytes(6).toString("hex")}-passwort`;
  const antwort = await sende(
    sitzung.cookie,
    "POST",
    "/api/auth/change-password",
    {
      currentPassword: sitzung.passwort,
      newPassword: neu,
    },
  );
  expect(antwort.status).toBe(200);
  return { ...sitzung, passwort: neu, cookie: cookiesAus(antwort) };
}

async function richteZweitenFaktorEin(sitzung: Sitzung): Promise<Sitzung> {
  const einrichten = await sende(
    sitzung.cookie,
    "POST",
    "/api/auth/two-factor/enable",
    {
      password: sitzung.passwort,
    },
  );
  expect(einrichten.status).toBe(200);
  const geprueft = await sende(
    sitzung.cookie,
    "POST",
    "/api/auth/two-factor/verify-totp",
    {
      code: await totpCode(welt, sitzung.id),
    },
  );
  expect(geprueft.status).toBe(200);
  return { ...sitzung, cookie: cookiesAus(geprueft) };
}

async function stimmeZu(sitzung: Sitzung) {
  // Ohne Zustimmung sperrt die API die App-Routen
  expect((await sende(sitzung.cookie, "GET", "/api/v1/ich")).status).toBe(200);
  expect(
    (
      await sende(
        sitzung.cookie,
        "GET",
        "/api/v1/programme?von=2027-01-01&bis=2027-12-31",
      )
    ).status,
  ).toBe(403);
  expect(
    (await sende(sitzung.cookie, "PUT", "/api/v1/einwilligung")).status,
  ).toBe(204);
}

test("vom leeren System bis zur ersten Einheit mit Kommando, Stellvertretung, Teilnehmenden und Eltern", async () => {
  const suffix = randomBytes(3).toString("hex");

  // 1. Die CLI legt den Kantonsadmin an; er wechselt das Startpasswort und richtet den zweiten Faktor ein
  const adminName = `kantonsadmin.${suffix}`;
  let admin = await meldeAn(adminName, legeKantonsadminAn(adminName));
  admin = await ersetzeStartpasswort(admin);
  // Ohne Faktor ist die Verwaltung zu
  const ohneFaktor = await sende(admin.cookie, "GET", "/api/v1/admin/bezirke");
  expect(ohneFaktor.status).toBe(403);
  expect(await ohneFaktor.json()).toMatchObject({
    code: "ZWEITER_FAKTOR_FEHLT",
  });
  admin = await richteZweitenFaktorEin(admin);

  // 2. Bezirk, Einheit und Kommando in der Verwaltung
  const bezirk = await sende(admin.cookie, "POST", "/api/v1/admin/bezirke", {
    name: `Bezirk ${suffix}`,
  });
  expect(bezirk.status).toBe(201);
  const kdtName = `kommando.${suffix}`;
  const einheit = await sende(admin.cookie, "POST", "/api/v1/admin/einheiten", {
    bezirkId: (await bezirk.json()).id,
    typ: "jf",
    name: `JF ${suffix}`,
    kommandant: {
      vorname: "Kim",
      nachname: "Kommando",
      benutzername: kdtName,
      telefon: "079 123 45 67",
    },
  });
  expect(einheit.status).toBe(201);
  const { id: einheitId, kommandant } = await einheit.json();

  // 3. Das Kommando meldet sich mit dem Startpasswort an, wechselt es, richtet den zweiten Faktor ein und stimmt zu
  let kdt = await meldeAn(kdtName, kommandant.startpasswort);
  kdt = await ersetzeStartpasswort(kdt);
  const gesperrt = await sende(kdt.cookie, "GET", "/api/v1/admin/einheiten");
  expect(gesperrt.status).toBe(403);
  expect(await gesperrt.json()).toMatchObject({ code: "ZWEITER_FAKTOR_FEHLT" });
  kdt = await richteZweitenFaktorEin(kdt);
  await stimmeZu(kdt);
  const einheiten = await (
    await sende(kdt.cookie, "GET", "/api/v1/admin/einheiten")
  ).json();
  expect(einheiten.einheiten).toMatchObject([{ id: einheitId, typ: "jf" }]);
  // Die App-Anmeldung verlangt ab jetzt den Code: Der Faktor gehört zum Konto
  kdt = await meldeAn(kdtName, kdt.passwort, true);

  // 4. Stellvertretung und Leitende
  const basis = `/api/v1/admin/einheiten/${einheitId}`;
  const stv = await sende(kdt.cookie, "POST", `${basis}/stellvertretungen`, {
    vorname: "Sven",
    nachname: "Stellvertretung",
    benutzername: `stv.${suffix}`,
  });
  expect(stv.status).toBe(201);
  expect((await stv.json()).reihenfolge).toBe(1);
  const leitende = await sende(kdt.cookie, "POST", `${basis}/leitende`, {
    vorname: "Lea",
    nachname: "Leitung",
    benutzername: `leitung.${suffix}`,
  });
  expect(leitende.status).toBe(201);

  // 5. Teilnehmende mit Eltern, über den CSV-Import (Vorschau, dann Import)
  const nachname = `Muster${suffix}`;
  const zeilen = [
    {
      vorname: "Anna",
      nachname,
      art: "eltern",
      elternVorname: "Eva",
      elternNachname: nachname,
    },
    {
      vorname: "Ben",
      nachname,
      art: "eltern",
      elternVorname: "Eva",
      elternNachname: nachname,
    },
    { vorname: "Cleo", nachname: `Eigen${suffix}`, art: "selbst" },
  ];
  const vorschau = await (
    await sende(kdt.cookie, "POST", `${basis}/import/vorschau`, { zeilen })
  ).json();
  expect(vorschau.summe).toMatchObject({ neu: 3, konten: 2 });
  const importiert = await sende(kdt.cookie, "POST", `${basis}/import`, {
    zeilen,
  });
  expect(importiert.status).toBe(201);
  const { konten } = await importiert.json();
  const elternKonto = konten.find((k: { art: string }) => k.art === "eltern");
  const kindKonto = konten.find((k: { art: string }) => k.art === "selbst");

  // 6. Die Eltern melden sich an, wechseln das Passwort, stimmen zu und sehen beide Kinder
  let eltern = await meldeAn(
    elternKonto.benutzername,
    elternKonto.startpasswort,
  );
  eltern = await ersetzeStartpasswort(eltern);
  await stimmeZu(eltern);
  const profil = await (
    await sende(eltern.cookie, "GET", "/api/v1/ich")
  ).json();
  expect(
    profil.teilnehmende.map((t: { vorname: string }) => t.vorname).sort(),
  ).toEqual(["Anna", "Ben"]);
  expect(profil.einheiten).toEqual([]);
  // Die Verwaltung bleibt den Eltern zu
  expect(
    (await sende(eltern.cookie, "GET", "/api/v1/admin/einheiten")).status,
  ).toBe(403);

  // 7. Das Kind mit eigenem Konto
  let kind = await meldeAn(kindKonto.benutzername, kindKonto.startpasswort);
  kind = await ersetzeStartpasswort(kind);
  await stimmeZu(kind);

  // 8. Konto-Wechsel: Anna bekommt ein eigenes Konto und verschwindet bei den Eltern
  const annaId = (
    await db
      .select({
        id: schema.teilnehmende.id,
        vorname: schema.teilnehmende.vorname,
      })
      .from(schema.teilnehmende)
      .where(eq(schema.teilnehmende.nachname, nachname))
  ).find((z) => z.vorname === "Anna")!.id;
  const wechsel = await sende(
    kdt.cookie,
    "POST",
    `${basis}/teilnehmende/${annaId}/konto-wechsel`,
    { benutzername: `anna.${suffix}` },
  );
  expect(wechsel.status).toBe(201);
  const annaKonto = await wechsel.json();
  const nachWechsel = await (
    await sende(eltern.cookie, "GET", "/api/v1/ich")
  ).json();
  expect(
    nachWechsel.teilnehmende.map((t: { vorname: string }) => t.vorname),
  ).toEqual(["Ben"]);
  let annaSitzung = await meldeAn(
    annaKonto.benutzername,
    annaKonto.startpasswort,
  );
  annaSitzung = await ersetzeStartpasswort(annaSitzung);
  await stimmeZu(annaSitzung);
  const annaProfil = await (
    await sende(annaSitzung.cookie, "GET", "/api/v1/ich")
  ).json();
  expect(annaProfil.teilnehmende).toMatchObject([
    { vorname: "Anna", art: "selbst" },
  ]);
});
