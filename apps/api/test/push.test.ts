import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { TokenMessage } from "firebase-admin/messaging";
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
} from "vitest";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { sendePush, type Fcm } from "../src/push.js";
import { fcmNachricht } from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";

const sql = postgres(API_URL);
const db = erstelleDb(sql);
const { pushToken } = schema;

// Eine Attrappe statt firebase-admin: Kein Netz, keine Schlüssel
let aufrufe: TokenMessage[][];
let codes: Record<string, string>;
let wirft: (aufruf: number) => unknown;
const fcm: Fcm = {
  async sendEach(nachrichten) {
    aufrufe.push(nachrichten);
    const fehler = wirft(aufrufe.length);
    if (fehler) throw fehler;
    return {
      responses: nachrichten.map(({ token }) =>
        codes[token]
          ? { success: false, error: { code: codes[token] } }
          : { success: true },
      ),
    };
  },
};
let logZeilen: Record<string, unknown>[];

let max: string;
let erika: string;
let sitzungen: string[];

beforeAll(async () => {
  const personen = await db
    .insert(schema.user)
    .values(
      ["Max Muster", "Erika Beispiel"].map((name) => ({
        name,
        email: `${randomUUID()}@example.org`,
      })),
    )
    .returning();
  max = personen[0]!.id;
  erika = personen[1]!.id;
  const jetzt = new Date();
  const ablauf = new Date(jetzt.getTime() + 3_600_000);
  // Eine Sitzung pro Token: 501 für Max, eine für Erika
  const zeilen = await db
    .insert(schema.session)
    .values(
      Array.from({ length: 502 }, (_, i) => ({
        token: randomUUID(),
        expiresAt: ablauf,
        updatedAt: jetzt,
        userId: i < 501 ? max : erika,
      })),
    )
    .returning({ id: schema.session.id });
  sitzungen = zeilen.map((z) => z.id);
});

beforeEach(() => {
  aufrufe = [];
  codes = {};
  wirft = () => undefined;
  logZeilen = [];
  vi.spyOn(console, "log").mockImplementation((zeile: string) => {
    const eintrag = JSON.parse(zeile) as Record<string, unknown>;
    if (eintrag.ereignis === "push") logZeilen.push(eintrag);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete(pushToken).where(inArray(pushToken.userId, [max, erika]));
});

afterAll(async () => {
  await db.delete(schema.user).where(inArray(schema.user.id, [max, erika]));
  await sql.end();
});

// Max' Sitzungen der Reihe nach; Erikas steht als letzte
async function legeTokens(anzahl: number, userId = max) {
  const zeilen = Array.from({ length: anzahl }, (_, i) => ({
    sessionId: userId === max ? sitzungen[i]! : sitzungen[501]!,
    token: `fcm-test-${randomUUID()}`,
    userId,
    plattform: "ios" as const,
  }));
  await db.insert(pushToken).values(zeilen);
  return zeilen.map((z) => z.token);
}

const vorhanden = async (tokens: string[]) =>
  (
    await db
      .select({ token: pushToken.token })
      .from(pushToken)
      .where(inArray(pushToken.token, tokens))
  ).map((z) => z.token);

const PUSH = {
  typ: "programm",
  kanal: "termine",
  id: "programm-1",
  titel: "Neues Programm",
} as const;
const alleTokens = () => aufrufe.flat().map((n) => n.token);

test("501 Tokens gehen in Blöcken zu 500 und 1, jedes Token einmal", async () => {
  const tokens = await legeTokens(501);
  await sendePush({ db, fcm }, [max], PUSH);
  expect(aufrufe.map((a) => a.length)).toEqual([500, 1]);
  expect(alleTokens().sort()).toEqual([...tokens].sort());
  expect(logZeilen).toEqual([]);
});

test("scheitert der erste Block, geht der zweite trotzdem hinaus", async () => {
  await legeTokens(501);
  wirft = (aufruf) =>
    aufruf === 1
      ? Object.assign(new Error("Netz"), { code: "app/network-error" })
      : undefined;
  await sendePush({ db, fcm }, [max], PUSH);
  expect(aufrufe.map((a) => a.length)).toEqual([500, 1]);
  expect(logZeilen).toEqual([
    expect.objectContaining({ ereignis: "push", code: "app/network-error" }),
  ]);
});

test("nur die Codes für ein ungültiges Token löschen es; jeder Fehler wird ohne Token geloggt", async () => {
  const [ok, tot, ungueltig, limit] = await legeTokens(4);
  codes = {
    [tot!]: "messaging/registration-token-not-registered",
    [ungueltig!]: "messaging/invalid-registration-token",
    [limit!]: "messaging/message-rate-exceeded",
  };
  await sendePush({ db, fcm }, [max], PUSH);
  expect((await vorhanden([ok!, tot!, ungueltig!, limit!])).sort()).toEqual(
    [ok!, limit!].sort(),
  );
  expect(logZeilen.map((z) => z.code).sort()).toEqual([
    "messaging/invalid-registration-token",
    "messaging/message-rate-exceeded",
    "messaging/registration-token-not-registered",
  ]);
  const zeilen = JSON.stringify(logZeilen);
  for (const token of [ok!, tot!, ungueltig!, limit!])
    expect(zeilen).not.toContain(token);
});

describe("Inhalt", () => {
  test("genau Titel, Typ und ID, Kanal und Ton; keine Personendaten", async () => {
    const [token] = await legeTokens(1);
    await sendePush({ db, fcm }, [max], {
      typ: "programm",
      kanal: "termine",
      id: "programm-1",
      titel: "Waldtag am Sa 31.10. wurde verschoben",
    });
    expect(aufrufe.flat()).toStrictEqual([
      fcmNachricht(
        token!,
        "Waldtag am Sa 31.10. wurde verschoben",
        { typ: "programm", id: "programm-1" },
        "termine",
      ),
    ]);
    // Namen und E-Mail-Adressen der Personen stehen in den Zeilen, aber in keiner Anfrage
    const anfrage = JSON.stringify(aufrufe);
    for (const geheim of ["Muster", "Beispiel", "example.org", max, erika])
      expect(anfrage).not.toContain(geheim);
  });

  test("ein zusätzliches Feld im Push erreicht FCM nicht", async () => {
    await legeTokens(1);
    await sendePush({ db, fcm }, [max], {
      ...PUSH,
      // @ts-expect-error Push hat kein Feld «daten»
      daten: { kind: "Kindername" },
    });
    const [nachricht] = aufrufe[0]!;
    expect(Object.keys(nachricht!).sort()).toEqual([
      "android",
      "apns",
      "data",
      "notification",
      "token",
    ]);
    expect(nachricht!.notification).toEqual({ title: "Neues Programm" });
    expect(nachricht!.data).toEqual({ typ: "programm", id: "programm-1" });
    expect(JSON.stringify(aufrufe)).not.toMatch(/Kindername/);
  });
});

test("ohne Token der Empfänger geht keine Anfrage hinaus", async () => {
  await legeTokens(1, erika);
  await sendePush({ db, fcm }, [], PUSH);
  // Max hat kein Token; Erikas Token gehört nicht zu den Empfängern
  await sendePush({ db, fcm }, [max], PUSH);
  expect(aufrufe).toEqual([]);
});

test("ohne Fcm (kein Schlüssel) geht nichts hinaus und die Token bleiben", async () => {
  const tokens = await legeTokens(2);
  await sendePush({ db }, [max], PUSH);
  expect(aufrufe).toEqual([]);
  expect(logZeilen).toEqual([]);
  expect((await vorhanden(tokens)).sort()).toEqual([...tokens].sort());
});

test("FCM wirft: Die Funktion kehrt zurück, loggt den Code und lässt die Token stehen", async () => {
  const tokens = await legeTokens(2);
  wirft = () =>
    Object.assign(new Error(`Kein Zugriff ${tokens[0]}`), {
      code: "app/invalid-credential",
    });
  await sendePush({ db, fcm }, [max], PUSH);
  expect(logZeilen).toEqual([
    expect.objectContaining({
      ereignis: "push",
      code: "app/invalid-credential",
    }),
  ]);
  expect(JSON.stringify(logZeilen)).not.toContain(tokens[0]);
  expect((await vorhanden(tokens)).sort()).toEqual([...tokens].sort());
});

test("beendete Datenbankverbindung: Die Funktion kehrt zurück, ohne Anfrage und mit einer Logzeile", async () => {
  const beendet = postgres(API_URL);
  await beendet.end();
  await sendePush({ db: erstelleDb(beendet), fcm }, [max], PUSH);
  expect(aufrufe).toEqual([]);
  expect(logZeilen).toEqual([
    expect.objectContaining({ ereignis: "push", code: "CONNECTION_ENDED" }),
  ]);
});
