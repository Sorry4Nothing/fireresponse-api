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
const abteilungen: string[] = [];
beforeEach(() => {
  nachrichten = [];
});
// Der Prüfer liest alle Regeln; was ein Test anlegt, darf den nächsten nicht treffen
afterEach(async () => {
  await db
    .delete(schema.zeitregel)
    .where(inArray(schema.zeitregel.abteilungId, abteilungen));
  abteilungen.length = 0;
});

// Eine eigene Abteilung pro Test: Die Regeln eines Tests dürfen die Programme der anderen nicht treffen
async function neueWelt() {
  const [abteilung] = await db
    .insert(schema.abteilung)
    .values({ name: "Zeitregeln" })
    .returning();
  abteilungen.push(abteilung!.id);
  const stufen = await db
    .insert(schema.stufe)
    .values(
      ["A", "B"].map((name) => ({
        abteilungId: abteilung!.id,
        name,
        kuerzel: name,
      })),
    )
    .returning();
  const [stufeA, stufeB] = stufen as [
    (typeof stufen)[number],
    (typeof stufen)[number],
  ];

  // Ein Elternteil mit Push-Token; die Kinder legt kindVon an
  async function elternteil(
    name: string,
    optionen: Partial<typeof schema.user.$inferInsert> = {},
  ) {
    const [konto] = await db
      .insert(schema.user)
      .values({
        name,
        email: `${randomUUID()}@example.org`,
        abteilungId: abteilung!.id,
        ...optionen,
      })
      .returning();
    const [sitzung] = await db
      .insert(schema.session)
      .values({
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        userId: konto!.id,
      })
      .returning();
    const token = `fcm-${randomUUID()}`;
    await db.insert(schema.pushToken).values({
      sessionId: sitzung!.id,
      token,
      userId: konto!.id,
      plattform: "android",
    });
    tokens.set(token, name);
    return konto!.id;
  }

  async function kindVon(
    eltern: string[],
    stufeId: string,
    inaktivSeit: Date | null = null,
  ) {
    const [k] = await db
      .insert(schema.kind)
      .values({
        abteilungId: abteilung!.id,
        vorname: "Kind",
        nachname: "Test",
        stufeId,
        inaktivSeit,
      })
      .returning();
    await db
      .insert(schema.kindEltern)
      .values(eltern.map((userId) => ({ kindId: k!.id, userId })));
    return k!.id;
  }

  const programm = (
    optionen: Partial<Parameters<typeof legeProgrammAn>[1]> = {},
  ) =>
    legeProgrammAn(db, {
      abteilungId: abteilung!.id,
      sichtbarkeit: "eltern",
      stufen: [stufeA.id],
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
        abteilungId: abteilung!.id,
        stufeId: null,
        wochentag: 3,
        uhrzeit: "08:00",
        text: "{Programm} am {Datum}: bitte antworten",
        ...optionen,
      })
      .returning();
    return r!;
  }

  // Die Namen der Eltern, die einen Push bekamen, sortiert
  const empfaenger = () => nachrichten.map((n) => tokens.get(n.token)!).sort();

  return {
    abteilung: abteilung!,
    stufeA,
    stufeB,
    elternteil,
    kindVon,
    programm,
    regel,
    empfaenger,
  };
}

const lauf = (jetzt: Date) => sendeFaelligeErinnerungen({ db, fcm }, jetzt);

describe("Erinnerungen", () => {
  test("nichts vor der Auslösezeit, ab ihr ein Push an Eltern ohne Antwort", async () => {
    const w = await neueWelt();
    const offen = await w.elternteil("offen");
    await w.kindVon([offen], w.stufeA.id);
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
      android: { notification: { channelId: "programme" } },
    });
    // Weder Kindername noch Nachname im Push
    expect(JSON.stringify(nachrichten[0])).not.toMatch(/Kind|Test/);
  });

  test("kein Push an Eltern mit gespeichertem «ja» oder «nein», an inaktive Kinder, andere Stufen und abgeschaltete Konten", async () => {
    const w = await neueWelt();
    const p = await w.programm();
    await w.regel();
    const ja = await w.elternteil("ja");
    const nein = await w.elternteil("nein");
    const offen = await w.elternteil("offen");
    const inaktiv = await w.elternteil("inaktiv");
    const andereStufe = await w.elternteil("andereStufe");
    const ohnePush = await w.elternteil("ohnePush", { pushProgramme: false });
    const gesperrt = await w.elternteil("gesperrt", { banned: true });
    const deaktiviert = await w.elternteil("deaktiviert", {
      deaktiviertAm: new Date(),
    });
    const kinder = {
      ja: await w.kindVon([ja], w.stufeA.id),
      nein: await w.kindVon([nein], w.stufeA.id),
    };
    await db.insert(schema.teilnahme).values([
      { programmId: p.id, kindId: kinder.ja, status: "ja" },
      { programmId: p.id, kindId: kinder.nein, status: "nein" },
    ]);
    await w.kindVon([offen], w.stufeA.id);
    await w.kindVon([inaktiv], w.stufeA.id, new Date());
    await w.kindVon([andereStufe], w.stufeB.id);
    await w.kindVon([ohnePush], w.stufeA.id);
    await w.kindVon([gesperrt], w.stufeA.id);
    await w.kindVon([deaktiviert], w.stufeA.id);

    await lauf(AUSLOESUNG);
    expect(w.empfaenger()).toEqual(["offen"]);
  });

  test("Eltern mit mehreren Kindern: ein Push pro Programm, und nur solange ein Kind offen ist", async () => {
    const w = await neueWelt();
    const p = await w.programm();
    await w.regel();
    const zwei = await w.elternteil("zwei");
    const eins = await w.elternteil("eins");
    const alle = await w.elternteil("alle");
    await w.kindVon([zwei], w.stufeA.id);
    await w.kindVon([zwei], w.stufeA.id);
    const beantwortet = await w.kindVon([eins], w.stufeA.id);
    await w.kindVon([eins], w.stufeA.id);
    const k1 = await w.kindVon([alle], w.stufeA.id);
    const k2 = await w.kindVon([alle], w.stufeA.id);
    await db.insert(schema.teilnahme).values(
      [beantwortet, k1, k2].map((kindId) => ({
        programmId: p.id,
        kindId,
        status: "ja" as const,
      })),
    );

    await lauf(AUSLOESUNG);
    expect(w.empfaenger()).toEqual(["eins", "zwei"]);
  });

  test("keine Doppelsendung: weder im nächsten Lauf noch nach einem Neustart noch nach Änderungen an Regel oder Programm", async () => {
    const w = await neueWelt();
    const eltern = await w.elternteil("offen");
    await w.kindVon([eltern], w.stufeA.id);
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
    const eltern = await w.elternteil("offen");
    await w.kindVon([eltern], w.stufeA.id);
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
    const eltern = await w.elternteil("offen");
    await w.kindVon([eltern], w.stufeA.id);
    await w.programm();
    await w.regel();

    // Der Server war am Mittwoch nicht erreichbar; am Freitag läuft der erste Lauf
    await lauf(new Date("2026-10-30T10:00:00Z"));
    expect(w.empfaenger()).toEqual(["offen"]);

    nachrichten = [];
    const spaet = await neueWelt();
    const e2 = await spaet.elternteil("offen");
    await spaet.kindVon([e2], spaet.stufeA.id);
    await spaet.programm();
    await spaet.regel();
    await lauf(NACH_BEGINN);
    expect(spaet.empfaenger()).toEqual([]);
  });

  test("eine Regel, die erst nach der Auslösezeit entsteht, holt nach", async () => {
    const w = await neueWelt();
    const eltern = await w.elternteil("offen");
    await w.kindVon([eltern], w.stufeA.id);
    await w.programm();

    await lauf(new Date("2026-10-29T12:00:00Z"));
    expect(nachrichten).toHaveLength(0);
    await w.regel();
    await lauf(new Date("2026-10-29T12:01:00Z"));
    expect(w.empfaenger()).toEqual(["offen"]);
  });

  test("Regel einer Stufe trifft nur Programme dieser Stufe; Regel für alle trifft jede Stufe des Programms", async () => {
    const w = await neueWelt();
    const a = await w.elternteil("a");
    const b = await w.elternteil("b");
    await w.kindVon([a], w.stufeA.id);
    await w.kindVon([b], w.stufeB.id);
    await w.programm({ stufen: [w.stufeA.id] });
    await w.regel({ stufeId: w.stufeB.id });
    await lauf(AUSLOESUNG);
    expect(nachrichten).toHaveLength(0);

    await w.regel({ stufeId: null, text: "Alle" });
    await lauf(AUSLOESUNG);
    expect(w.empfaenger()).toEqual(["a"]);

    // Ein Abteilungsprogramm mit beiden Stufen erreicht beide Eltern, jedes Elternteil einmal je Regel
    nachrichten = [];
    await w.programm({
      stufen: [w.stufeA.id, w.stufeB.id],
      beginn: new Date("2026-11-07T13:00:00Z"),
    });
    await lauf(new Date("2026-11-04T07:00:00Z"));
    // Die Regel für Stufe B und die Regel für alle: b zweimal, a einmal
    expect(w.empfaenger()).toEqual(["a", "b", "b"]);
  });

  test("keine Erinnerung für interne, nur für Leitende sichtbare, abgesagte oder begonnene Programme, ausgeschaltete Regeln und fremde Abteilungen", async () => {
    const w = await neueWelt();
    const eltern = await w.elternteil("offen");
    await w.kindVon([eltern], w.stufeA.id);
    await w.regel();
    await w.regel({ aktiv: false, text: "aus" });
    for (const sichtbarkeit of ["intern", "leitende"] as const) {
      await w.programm({ sichtbarkeit });
    }
    const abgesagt = await w.programm();
    await db
      .update(schema.programm)
      .set({ status: "abgesagt" })
      .where(eq(schema.programm.id, abgesagt.id));
    await w.programm({ beginn: new Date("2026-10-28T06:00:00Z") });
    await w.programm({ stufen: [] });
    const fremd = await neueWelt();
    await fremd.programm();
    // Eine Regel der fremden Abteilung trifft die Programme dieser Abteilung nicht
    await fremd.regel({ stufeId: fremd.stufeB.id });

    await lauf(AUSLOESUNG);
    expect(nachrichten).toHaveLength(0);
  });
});
