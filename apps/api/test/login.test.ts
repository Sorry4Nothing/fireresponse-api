import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
import { ladeSeiten } from "../src/seiten.js";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import {
  erzeugeStartpasswort,
  normalisiereStartpasswort,
  startpasswortFelder,
} from "../src/startpasswort.js";
import {
  APP,
  bereiteAuthTestsVor,
  cookiesAus,
  erstelleTestAuth,
  PASSWORT,
  zufallsIp,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import { erstelleWelt, type Welt } from "./hilfen/personas.js";

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

const FALSCH = "nur-fuer-tests-falsch";
// Für jeden Anmeldefehler dieselbe Antwort, Wort für Wort
const FEHLGESCHLAGEN = {
  code: "ANMELDUNG_FEHLGESCHLAGEN",
  message:
    "Anmeldung nicht möglich. Bitte Benutzername und Passwort prüfen oder später nochmals versuchen. Sonst hilft ein Admin.",
};
const MINUTE = 60_000;

let welt: Welt;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
});

// Jede Anfrage schreibt sonst eine Log-Zeile in die Testausgabe; die Logger-Tests lesen die Zeilen aus dem Spy
let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

async function legeKonto(
  daten: Record<string, unknown> = {},
  passwort = PASSWORT,
) {
  const benutzername = `login.${randomUUID().slice(0, 8)}`;
  const { user } = await auth.api.createUser({
    body: {
      email: `${randomUUID()}@example.org`,
      password: passwort,
      name: "Testperson",
      data: {
        username: benutzername,
        abteilungId: welt.testabteilungId,
        mussPasswortAendern: false,
        ...daten,
      },
    },
  });
  return { id: user.id, benutzername };
}

// Durch die App, wie der Expo-Client; eigene IP pro Anfrage, damit kein Rate-Limit greift
function anmeldung(benutzername: string, passwort: string) {
  return app.request("/api/auth/sign-in/username", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "expo-origin": APP,
      "x-forwarded-for": zufallsIp(),
    },
    body: JSON.stringify({ username: benutzername, password: passwort }),
  });
}

async function bremse(id: string) {
  const [zeile] = await db
    .select({
      fehlversuche: schema.user.fehlversuche,
      naechsterVersuchAb: schema.user.naechsterVersuchAb,
    })
    .from(schema.user)
    .where(eq(schema.user.id, id));
  return zeile;
}

// Zeit vorrücken wie im Sitzungstest: zurückgestellt statt vorgespult, die Uhr bleibt echt
async function vorruecken(id: string, minuten: number) {
  const { naechsterVersuchAb } = await bremse(id);
  await db
    .update(schema.user)
    .set({
      naechsterVersuchAb: new Date(
        naechsterVersuchAb!.getTime() - minuten * MINUTE,
      ),
    })
    .where(eq(schema.user.id, id));
}

function sitzungen(id: string) {
  return db
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(eq(schema.session.userId, id));
}

describe("eine Meldung für jeden Anmeldefehler", () => {
  test("falsches Passwort, unbekannter Name, Wartezeit, abgelaufenes Startpasswort, deaktiviert und ungültiger Name: 401 mit demselben Body, ohne Cookie", async () => {
    const normal = await legeKonto();
    const wartend = await legeKonto({
      fehlversuche: 5,
      naechsterVersuchAb: new Date(Date.now() + MINUTE),
    });
    const startpasswort = erzeugeStartpasswort();
    const abgelaufen = await legeKonto(
      {
        ...startpasswortFelder(),
        startpasswortGueltigBis: new Date(Date.now() - MINUTE),
      },
      normalisiereStartpasswort(startpasswort),
    );
    const deaktiviert = await legeKonto();
    await db
      .update(schema.user)
      .set({ banned: true })
      .where(eq(schema.user.id, deaktiviert.id));

    const faelle: [string, string, string][] = [
      ["falsches Passwort", normal.benutzername, FALSCH],
      ["unbekannter Name", "gibt.es.nicht", PASSWORT],
      ["Wartezeit trotz richtigem Passwort", wartend.benutzername, PASSWORT],
      [
        "abgelaufenes Startpasswort trotz richtigem Passwort",
        abgelaufen.benutzername,
        startpasswort,
      ],
      ["deaktiviert", deaktiviert.benutzername, PASSWORT],
      ["ungültiger Name", "x", PASSWORT],
    ];
    for (const [fall, benutzername, passwort] of faelle) {
      const antwort = await anmeldung(benutzername, passwort);
      expect(antwort.status, fall).toBe(401);
      expect(await antwort.json(), fall).toEqual(FEHLGESCHLAGEN);
      expect(cookiesAus(antwort), fall).toBe("");
    }
  });
});

describe("Bremse pro Benutzername, nur für Fehlversuche", () => {
  test("die ersten 4 Fehlversuche ohne Wartezeit, der 5. setzt 1 Minute; ein anderes Konto bleibt unberührt", async () => {
    const konto = await legeKonto();
    const anderes = await legeKonto();
    for (const n of [1, 2, 3, 4]) {
      expect((await anmeldung(konto.benutzername, FALSCH)).status).toBe(401);
      const { fehlversuche, naechsterVersuchAb } = await bremse(konto.id);
      expect(fehlversuche).toBe(n);
      // Ohne Wartezeit hält naechsterVersuchAb nur den Fehlversuch fest
      expect(naechsterVersuchAb!.getTime()).toBeLessThanOrEqual(Date.now());
    }
    const vorher = Date.now();
    expect((await anmeldung(konto.benutzername, FALSCH)).status).toBe(401);
    const danach = await bremse(konto.id);
    expect(danach.fehlversuche).toBe(5);
    expect(danach.naechsterVersuchAb!.getTime()).toBeGreaterThanOrEqual(
      vorher + MINUTE,
    );
    expect(danach.naechsterVersuchAb!.getTime()).toBeLessThanOrEqual(
      Date.now() + MINUTE,
    );
    expect(await bremse(anderes.id)).toEqual({
      fehlversuche: 0,
      naechsterVersuchAb: null,
    });
  });

  test.each([
    [5, 1],
    [6, 5],
    [7, 15],
  ])("der %i. Fehlversuch in Folge setzt %i Minuten", async (n, minuten) => {
    // Die vorige Wartezeit ist eben um, der vorige Fehlversuch liegt weniger als 15 Minuten zurück
    const konto = await legeKonto({
      fehlversuche: n - 1,
      naechsterVersuchAb: new Date(Date.now() - 1000),
    });
    const vorher = Date.now();
    expect((await anmeldung(konto.benutzername, FALSCH)).status).toBe(401);
    const { fehlversuche, naechsterVersuchAb } = await bremse(konto.id);
    expect(fehlversuche).toBe(n);
    expect(naechsterVersuchAb!.getTime()).toBeGreaterThanOrEqual(
      vorher + minuten * MINUTE,
    );
    expect(naechsterVersuchAb!.getTime()).toBeLessThanOrEqual(
      Date.now() + minuten * MINUTE,
    );
  });

  test("während der Wartezeit prüft, zählt und verlängert der Server nichts: auch das richtige Passwort öffnet keine Sitzung", async () => {
    const ab = new Date(Date.now() + MINUTE);
    const konto = await legeKonto({ fehlversuche: 5, naechsterVersuchAb: ab });
    const antwort = await anmeldung(konto.benutzername, PASSWORT);
    expect(antwort.status).toBe(401);
    expect(await antwort.json()).toEqual(FEHLGESCHLAGEN);
    expect(await bremse(konto.id)).toEqual({
      fehlversuche: 5,
      naechsterVersuchAb: ab,
    });
    expect(await sitzungen(konto.id)).toEqual([]);
  });

  test("eine erfolgreiche Anmeldung setzt die Bremse zurück", async () => {
    const konto = await legeKonto({ fehlversuche: 3 });
    expect((await anmeldung(konto.benutzername, PASSWORT)).status).toBe(200);
    expect(await bremse(konto.id)).toEqual({
      fehlversuche: 0,
      naechsterVersuchAb: null,
    });
  });

  test("ein neues Startpasswort (startpasswortFelder) setzt die Bremse zurück: Der nächste Fehlversuch zählt wieder, statt zu warten", async () => {
    const konto = await legeKonto({
      fehlversuche: 6,
      naechsterVersuchAb: new Date(Date.now() + 15 * MINUTE),
    });
    await db
      .update(schema.user)
      .set(startpasswortFelder())
      .where(eq(schema.user.id, konto.id));
    expect((await anmeldung(konto.benutzername, FALSCH)).status).toBe(401);
    const { fehlversuche, naechsterVersuchAb } = await bremse(konto.id);
    expect(fehlversuche).toBe(1);
    expect(naechsterVersuchAb!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test("viele Fehlversuche, dann 15 Minuten ohne: Der Zähler beginnt bei 0, und das richtige Passwort meldet ohne Admin an", async () => {
    const konto = await legeKonto();
    // 4 ohne Wartezeit, dann 1, 5 und 15 Minuten, jede abgewartet
    for (const minuten of [0, 0, 0, 0, 1, 5, 15]) {
      expect((await anmeldung(konto.benutzername, FALSCH)).status).toBe(401);
      await vorruecken(konto.id, minuten);
    }
    expect((await bremse(konto.id)).fehlversuche).toBe(7);

    expect((await anmeldung(konto.benutzername, FALSCH)).status).toBe(401);
    const { fehlversuche, naechsterVersuchAb } = await bremse(konto.id);
    expect(fehlversuche).toBe(1);
    expect(naechsterVersuchAb!.getTime()).toBeLessThanOrEqual(Date.now());

    expect((await anmeldung(konto.benutzername, PASSWORT)).status).toBe(200);
    expect(await bremse(konto.id)).toEqual({
      fehlversuche: 0,
      naechsterVersuchAb: null,
    });
  });

  test("ein fremder Fehlversuch alle 15 Minuten setzt keine Wartezeit: Das Konto bleibt offen", async () => {
    // 7 Fehlversuche, die Wartezeit von 15 Minuten ist eben um
    const konto = await legeKonto({
      fehlversuche: 7,
      naechsterVersuchAb: new Date(Date.now() - 1000),
    });
    for (let runde = 0; runde < 8; runde++) {
      expect((await anmeldung(konto.benutzername, FALSCH)).status).toBe(401);
      const { fehlversuche, naechsterVersuchAb } = await bremse(konto.id);
      expect(fehlversuche, `Runde ${runde}`).toBe(1);
      expect(naechsterVersuchAb!.getTime()).toBeLessThanOrEqual(Date.now());
      await vorruecken(konto.id, 15);
    }
    expect((await anmeldung(konto.benutzername, PASSWORT)).status).toBe(200);
  });

  test("ein Zähler ohne Zeitpunkt beginnt beim nächsten Fehlversuch bei 0", async () => {
    const konto = await legeKonto({ fehlversuche: 4 });
    expect((await anmeldung(konto.benutzername, FALSCH)).status).toBe(401);
    expect((await bremse(konto.id)).fehlversuche).toBe(1);
  });

  test("abgelaufenes Startpasswort: das richtige zählt keinen Fehlversuch und öffnet keine Sitzung, ein falsches zählt", async () => {
    const startpasswort = erzeugeStartpasswort();
    const konto = await legeKonto(
      startpasswortFelder(),
      normalisiereStartpasswort(startpasswort),
    );
    await db
      .update(schema.user)
      .set({ startpasswortGueltigBis: new Date(Date.now() - MINUTE) })
      .where(eq(schema.user.id, konto.id));

    expect((await anmeldung(konto.benutzername, startpasswort)).status).toBe(
      401,
    );
    expect(await sitzungen(konto.id)).toEqual([]);
    expect(await bremse(konto.id)).toEqual({
      fehlversuche: 0,
      naechsterVersuchAb: null,
    });

    expect((await anmeldung(konto.benutzername, FALSCH)).status).toBe(401);
    expect((await bremse(konto.id)).fehlversuche).toBe(1);
  });
});

describe("normalisierter Vergleich bei offenem Startpasswort", () => {
  test("das Startpasswort in Kleinbuchstaben mit Leerzeichen statt Bindestrichen meldet an", async () => {
    const startpasswort = erzeugeStartpasswort();
    const konto = await legeKonto(
      startpasswortFelder(),
      normalisiereStartpasswort(startpasswort),
    );
    const eingabe = startpasswort.toLowerCase().replaceAll("-", " ");
    const antwort = await anmeldung(konto.benutzername, eingabe);
    expect(antwort.status).toBe(200);
    expect(cookiesAus(antwort)).toContain("session_token");
  });
});

describe("Sitzung: 90 Tage, verlängert bei Nutzung", () => {
  test("das Cookie kommt mit Max-Age=7776000, expires_at liegt rund 90 Tage voraus, und get-session verlängert, sobald fällig", async () => {
    const konto = await legeKonto();
    const angemeldet = await anmeldung(konto.benutzername, PASSWORT);
    expect(angemeldet.status).toBe(200);
    expect(
      angemeldet.headers
        .getSetCookie()
        .find((cookie) => cookie.includes("session_token")),
    ).toContain("Max-Age=7776000");

    const neunzigTage = 90 * 86_400_000;
    const [sitzung] = await db
      .select({ expiresAt: schema.session.expiresAt })
      .from(schema.session)
      .where(eq(schema.session.userId, konto.id));
    expect(sitzung.expiresAt.getTime() - Date.now()).toBeGreaterThan(
      neunzigTage - MINUTE,
    );
    expect(sitzung.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      neunzigTage,
    );

    // Fällig machen wie im Kaltstart-Test: zurückgestellt statt Zeit vorgespult, die Uhr bleibt echt
    const { updateAge } = (await auth.$context).sessionConfig;
    const [{ expiresAt: zurueck }] = await db
      .update(schema.session)
      .set({
        expiresAt: new Date(
          sitzung.expiresAt.getTime() - (updateAge + 60) * 1000,
        ),
      })
      .where(eq(schema.session.userId, konto.id))
      .returning({ expiresAt: schema.session.expiresAt });
    const sitzungAntwort = await app.request("/api/auth/get-session", {
      headers: {
        "expo-origin": APP,
        "x-forwarded-for": zufallsIp(),
        cookie: cookiesAus(angemeldet),
      },
    });
    expect(sitzungAntwort.status).toBe(200);
    const [nachher] = await db
      .select({ expiresAt: schema.session.expiresAt })
      .from(schema.session)
      .where(eq(schema.session.userId, konto.id));
    expect(nachher.expiresAt.getTime()).toBeGreaterThan(zurueck.getTime());
  });
});

describe("better-auth-Logger als eine JSON-Zeile", () => {
  test("eine Warnung wird zu zeit, quelle, stufe und meldung", async () => {
    await anmeldung("gibt.es.nicht", PASSWORT);
    const zeilen = ausgabe.mock.calls
      .map(([zeile]) => JSON.parse(zeile as string))
      .filter((eintrag) => eintrag.quelle === "better-auth");
    expect(zeilen).toContainEqual({
      zeit: expect.any(String),
      quelle: "better-auth",
      stufe: "warn",
      meldung: "User not found",
    });
  });

  test("ein Error als Meldung: nur sein Name landet im Log, Argumente nie", async () => {
    const { logger } = await auth.$context;
    const planted = new Error("<Max Muster> 203.0.113.7");
    logger.error(planted as unknown as string);
    logger.warn("Hinweis ohne Details", planted);
    for (const [zeile] of ausgabe.mock.calls) {
      expect(String(zeile).toLowerCase()).not.toContain("max muster");
      expect(String(zeile)).not.toContain("203.0.113.7");
    }
    const eintraege = ausgabe.mock.calls
      .map(([zeile]) => JSON.parse(zeile as string))
      .filter((eintrag) => eintrag.quelle === "better-auth");
    expect(eintraege).toContainEqual({
      zeit: expect.any(String),
      quelle: "better-auth",
      stufe: "error",
      meldung: "Error",
    });
    expect(eintraege).toContainEqual({
      zeit: expect.any(String),
      quelle: "better-auth",
      stufe: "warn",
      meldung: "Hinweis ohne Details",
    });
  });
});
