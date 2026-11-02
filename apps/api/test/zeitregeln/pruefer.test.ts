import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { TokenMessage } from "firebase-admin/messaging";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { erstelleDb } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";
import type { Fcm } from "../../src/push.js";
import {
  pruefeZeitregeln,
  sendeFaelligeErinnerungen,
} from "../../src/zeitregeln/pruefer.js";
import { API_URL } from "../hilfen/datenbank.js";
import { legeProgrammAn } from "../hilfen/programme.js";

const sql = postgres(API_URL);
const db = erstelleDb(sql);
afterAll(() => sql.end());

// Feste Zeitpunkte, nie die Uhr: Programm Sa 31.10.2026 14:00 MEZ, Regel Mi 08:00 löst am Mi 28.10. um 07:00 UTC aus
const BEGINN = new Date("2026-10-31T13:00:00Z");
const VOR_AUSLOESUNG = new Date("2026-10-28T06:59:00Z");
const AUSLOESUNG = new Date("2026-10-28T07:00:00Z");
const NACH_BEGINN = new Date("2026-10-31T13:00:01Z");

let nachrichten: TokenMessage[];
// Der Prüfer liest die ganze Datenbank; Pushes an Konten anderer Testdateien zählen hier nicht
const tokens = new Map<string, string>();
const fcm: Fcm = {
  async sendEach(liste) {
    nachrichten.push(...liste.filter((n) => tokens.has(n.token)));
    return { responses: liste.map(() => ({ success: true })) };
  },
};
const einheiten: string[] = [];
beforeEach(() => {
  nachrichten = [];
});
// Der Prüfer liest alle Regeln; was ein Test anlegt, darf den nächsten nicht treffen
afterEach(async () => {
  await db
    .delete(schema.zeitregel)
    .where(inArray(schema.zeitregel.einheitId, einheiten));
  einheiten.length = 0;
});

// Eine eigene Einheit pro Test: Die Regeln eines Tests dürfen die Programme der anderen nicht treffen
async function neueWelt() {
  const [bezirk] = await db
    .insert(schema.bezirk)
    .values({ name: `Zeitregeln ${randomUUID()}` })
    .returning();
  const [einheit] = await db
    .insert(schema.einheit)
    .values({ bezirkId: bezirk!.id, typ: "jf", name: "Zeitregeln" })
    .returning();
  einheiten.push(einheit!.id);

  // Ein Konto mit Push-Token; die teilnehmenden Personen legt personVon an
  async function konto(
    name: string,
    optionen: Partial<typeof schema.user.$inferInsert> = {},
  ) {
    const [k] = await db
      .insert(schema.user)
      .values({ name, email: `${randomUUID()}@example.org`, ...optionen })
      .returning();
    const [sitzung] = await db
      .insert(schema.session)
      .values({
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        userId: k!.id,
      })
      .returning();
    const token = `fcm-${randomUUID()}`;
    await db.insert(schema.pushToken).values({
      sessionId: sitzung!.id,
      token,
      userId: k!.id,
      plattform: "android",
    });
    tokens.set(token, name);
    return k!.id;
  }

  async function personVon(
    eltern: string[],
    einheitId: string = einheit!.id,
    inaktivSeit: Date | null = null,
  ) {
    const [t] = await db
      .insert(schema.teilnehmende)
      .values({ einheitId, vorname: "Person", nachname: "Test", inaktivSeit })
      .returning();
    await db.insert(schema.teilnehmendeKonto).values(
      eltern.map((userId) => ({
        teilnehmendeId: t!.id,
        userId,
        art: "eltern" as const,
      })),
    );
    return t!.id;
  }

  const programm = (
    optionen: Partial<Parameters<typeof legeProgrammAn>[1]> = {},
  ) =>
    legeProgrammAn(db, {
      einheitId: einheit!.id,
      titel: "Waldtag",
      beginn: BEGINN,
      ...optionen,
    });

  async function regel(
    optionen: Partial<typeof schema.zeitregel.$inferInsert> = {},
  ) {
    const [r] = await db
      .insert(schema.zeitregel)
      .values({
        einheitId: einheit!.id,
        wochentag: 3,
        uhrzeit: "08:00",
        text: "{Programm} am {Datum}: bitte antworten",
        ...optionen,
      })
      .returning();
    return r!;
  }

  // Die Namen der Konten, die einen Push bekamen, sortiert
  const empfaenger = () => nachrichten.map((n) => tokens.get(n.token)!).sort();

  return { einheit: einheit!, konto, personVon, programm, regel, empfaenger };
}

const lauf = (jetzt: Date) => sendeFaelligeErinnerungen({ db, fcm }, jetzt);

describe("Erinnerungen", () => {
  test("nichts vor der Auslösezeit, ab ihr ein Push an Konten ohne Antwort", async () => {
    const w = await neueWelt();
    const offen = await w.konto("offen");
    await w.personVon([offen]);
    const p = await w.programm();
    await w.regel({ beschreibung: "Bitte {Programm} bis heute beantworten" });

    await lauf(VOR_AUSLOESUNG);
    expect(nachrichten).toHaveLength(0);

    await lauf(AUSLOESUNG);
    expect(w.empfaenger()).toEqual(["offen"]);
    expect(nachrichten[0]).toMatchObject({
      notification: {
        title: "Waldtag am Sa 31.10.: bitte antworten",
        body: "Bitte Waldtag bis heute beantworten",
      },
      data: { typ: "programm", id: p.id },
      android: { notification: { channelId: "termine" } },
    });
    // Weder Vorname noch Nachname im Push
    expect(JSON.stringify(nachrichten[0])).not.toMatch(/Person|Test/);
  });

  test("kein Push bei gespeichertem «ja» oder «nein», für inaktive Personen, andere Einheiten und abgeschaltete Konten", async () => {
    const w = await neueWelt();
    const andere = await neueWelt();
    const p = await w.programm();
    await w.regel();
    const ja = await w.konto("ja");
    const nein = await w.konto("nein");
    const offen = await w.konto("offen");
    const inaktiv = await w.konto("inaktiv");
    const andereEinheit = await w.konto("andereEinheit");
    const ohnePush = await w.konto("ohnePush", { pushProgramme: false });
    const gesperrt = await w.konto("gesperrt", { banned: true });
    const deaktiviert = await w.konto("deaktiviert", {
      deaktiviertAm: new Date(),
    });
    const personen = {
      ja: await w.personVon([ja]),
      nein: await w.personVon([nein]),
    };
    await db.insert(schema.teilnahme).values([
      { programmId: p.id, teilnehmendeId: personen.ja, status: "ja" },
      { programmId: p.id, teilnehmendeId: personen.nein, status: "nein" },
    ]);
    await w.personVon([offen]);
    await w.personVon([inaktiv], w.einheit.id, new Date());
    await w.personVon([andereEinheit], andere.einheit.id);
    await w.personVon([ohnePush]);
    await w.personVon([gesperrt]);
    await w.personVon([deaktiviert]);

    await lauf(AUSLOESUNG);
    expect(w.empfaenger()).toEqual(["offen"]);
  });

  test("Kommando und Leitende bekommen die Erinnerung, bis sie sich angemeldet haben", async () => {
    const w = await neueWelt();
    const p = await w.programm();
    await w.regel();
    const kommando = await w.konto("kommando");
    const stv = await w.konto("stellvertretung");
    const angemeldet = await w.konto("angemeldet");
    await db.insert(schema.einheitRolle).values([
      { userId: kommando, einheitId: w.einheit.id, typ: "kommandant" },
      {
        userId: stv,
        einheitId: w.einheit.id,
        typ: "stellvertretung",
        reihenfolge: 1,
      },
      { userId: angemeldet, einheitId: w.einheit.id, typ: "leitung" },
    ]);
    await db.insert(schema.leitungAnmeldung).values({
      programmId: p.id,
      userId: angemeldet,
      status: "nein",
    });

    await lauf(AUSLOESUNG);
    expect(w.empfaenger()).toEqual(["kommando", "stellvertretung"]);
  });

  test("Eltern mit mehreren Personen: ein Push pro Programm, und nur solange eine Person offen ist", async () => {
    const w = await neueWelt();
    const p = await w.programm();
    await w.regel();
    const zwei = await w.konto("zwei");
    const eins = await w.konto("eins");
    const alle = await w.konto("alle");
    await w.personVon([zwei]);
    await w.personVon([zwei]);
    const beantwortet = await w.personVon([eins]);
    await w.personVon([eins]);
    const t1 = await w.personVon([alle]);
    const t2 = await w.personVon([alle]);
    await db.insert(schema.teilnahme).values(
      [beantwortet, t1, t2].map((teilnehmendeId) => ({
        programmId: p.id,
        teilnehmendeId,
        status: "ja" as const,
      })),
    );

    await lauf(AUSLOESUNG);
    expect(w.empfaenger()).toEqual(["eins", "zwei"]);
  });

  test("keine Doppelsendung: weder im nächsten Lauf noch nach einem Neustart noch nach Änderungen an Regel oder Programm", async () => {
    const w = await neueWelt();
    const eltern = await w.konto("offen");
    await w.personVon([eltern]);
    const p = await w.programm();
    const regel = await w.regel();

    await lauf(AUSLOESUNG);
    await lauf(new Date(AUSLOESUNG.getTime() + 60_000));
    // Neustart: ein neuer Prozess mit eigener Verbindung, nur die Datenbank erinnert sich
    expect(
      await pruefeZeitregeln({
        datenbankUrl: API_URL,
        fcm,
        jetzt: new Date(AUSLOESUNG.getTime() + 120_000),
      }),
    ).toBe("fertig");
    expect(nachrichten).toHaveLength(1);

    // Regel aus und wieder ein, anderer Text, Programm verschoben: dasselbe Paar bleibt gesendet
    await db
      .update(schema.zeitregel)
      .set({ aktiv: false })
      .where(eq(schema.zeitregel.id, regel.id));
    await db
      .update(schema.zeitregel)
      .set({ aktiv: true, text: "Neuer Text" })
      .where(eq(schema.zeitregel.id, regel.id));
    await db
      .update(schema.programm)
      .set({ beginn: new Date("2026-11-01T13:00:00Z") })
      .where(eq(schema.programm.id, p.id));
    await lauf(new Date("2026-11-01T08:00:00Z"));
    expect(nachrichten).toHaveLength(1);
  });

  test("zwei Läufe gleichzeitig senden einmal", async () => {
    const w = await neueWelt();
    const eltern = await w.konto("offen");
    await w.personVon([eltern]);
    await w.programm();
    await w.regel();

    await Promise.all([lauf(AUSLOESUNG), lauf(AUSLOESUNG)]);
    expect(nachrichten).toHaveLength(1);
  });

  test("ein laufender Lauf sperrt den nächsten", async () => {
    const fremd = postgres(API_URL, { max: 1 });
    try {
      await fremd`select pg_advisory_lock(740029)`;
      expect(
        await pruefeZeitregeln({
          datenbankUrl: API_URL,
          fcm,
          jetzt: AUSLOESUNG,
        }),
      ).toBe("gesperrt");
    } finally {
      await fremd.end();
    }
  });

  test("eine verpasste Erinnerung wird bis Programmbeginn nachgeholt, danach nicht mehr", async () => {
    const w = await neueWelt();
    const eltern = await w.konto("offen");
    await w.personVon([eltern]);
    await w.programm();
    await w.regel();

    // Der Server war am Mittwoch nicht erreichbar; am Freitag läuft der erste Lauf
    await lauf(new Date("2026-10-30T10:00:00Z"));
    expect(w.empfaenger()).toEqual(["offen"]);

    nachrichten = [];
    const spaet = await neueWelt();
    const e2 = await spaet.konto("offen");
    await spaet.personVon([e2]);
    await spaet.programm();
    await spaet.regel();
    await lauf(NACH_BEGINN);
    expect(spaet.empfaenger()).toEqual([]);
  });

  test("eine Regel, die erst nach der Auslösezeit entsteht, holt nach", async () => {
    const w = await neueWelt();
    const eltern = await w.konto("offen");
    await w.personVon([eltern]);
    await w.programm();

    await lauf(new Date("2026-10-29T12:00:00Z"));
    expect(nachrichten).toHaveLength(0);
    await w.regel();
    await lauf(new Date("2026-10-29T12:01:00Z"));
    expect(w.empfaenger()).toEqual(["offen"]);
  });

  test("eine Regel gilt nur für die Programme ihrer Einheit", async () => {
    const w = await neueWelt();
    const fremd = await neueWelt();
    const a = await w.konto("a");
    await w.personVon([a]);
    await w.programm();
    // Nur die Regel der fremden Einheit: Das Programm von w bleibt still
    await fremd.regel();
    await lauf(AUSLOESUNG);
    expect(nachrichten).toHaveLength(0);

    await w.regel({ text: "Eigene" });
    await lauf(AUSLOESUNG);
    expect(w.empfaenger()).toEqual(["a"]);
  });

  test("keine Erinnerung für abgesagte oder begonnene Programme, ausgeschaltete Regeln und fremde Einheiten", async () => {
    const w = await neueWelt();
    const eltern = await w.konto("offen");
    await w.personVon([eltern]);
    await w.regel({ aktiv: false, text: "aus" });
    const abgesagt = await w.programm();
    await w.regel();
    await db
      .update(schema.programm)
      .set({ status: "abgesagt" })
      .where(eq(schema.programm.id, abgesagt.id));
    await w.programm({ beginn: new Date("2026-10-28T06:00:00Z") });
    const fremd = await neueWelt();
    await fremd.programm();
    // Eine Regel der fremden Einheit trifft die Programme dieser Einheit nicht
    await fremd.regel();

    await lauf(AUSLOESUNG);
    expect(nachrichten).toHaveLength(0);
  });

  test("nur im Anmeldefenster: vorher keine Erinnerung, ab dem Öffnungstag eine", async () => {
    const w = await neueWelt();
    const eltern = await w.konto("offen");
    await w.personVon([eltern]);
    await w.programm();
    await w.regel();
    // 2 Tage: Die Anmeldung öffnet am Mi 29.10., einen Tag nach der Auslösezeit der Regel
    const mitFenster = (jetzt: Date) =>
      sendeFaelligeErinnerungen({ db, fcm, anmeldefensterTage: 2 }, jetzt);

    await mitFenster(AUSLOESUNG);
    await mitFenster(new Date("2026-10-28T22:59:00Z"));
    expect(nachrichten).toHaveLength(0);

    // Mitternacht in Zürich (MEZ) ist 23:00 UTC
    await mitFenster(new Date("2026-10-28T23:00:00Z"));
    expect(w.empfaenger()).toEqual(["offen"]);
  });

  test("Termine einer Art ohne Anmeldung bekommen keine Erinnerung", async () => {
    const w = await neueWelt();
    const eltern = await w.konto("offen");
    await w.personVon([eltern]);
    await w.programm({ art: "Sitzung", anmeldbar: false });
    await w.programm({ art: null });
    await w.regel();

    await lauf(AUSLOESUNG);
    expect(nachrichten).toHaveLength(0);

    // Mit der Freigabe der Art erinnert der nächste Lauf
    await db
      .update(schema.einheit)
      .set({ anmeldeArten: ["Sitzung"] })
      .where(eq(schema.einheit.id, w.einheit.id));
    await lauf(AUSLOESUNG);
    expect(w.empfaenger()).toEqual(["offen"]);
  });

  test("ein weites Fenster hält die Erinnerung nicht zurück", async () => {
    const w = await neueWelt();
    const eltern = await w.konto("offen");
    await w.personVon([eltern]);
    await w.programm();
    await w.regel();

    await sendeFaelligeErinnerungen(
      { db, fcm, anmeldefensterTage: 365 },
      AUSLOESUNG,
    );
    expect(w.empfaenger()).toEqual(["offen"]);
  });
});
