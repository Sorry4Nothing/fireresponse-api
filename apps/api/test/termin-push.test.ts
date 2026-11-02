import { randomUUID } from "node:crypto";
import type { TokenMessage } from "firebase-admin/messaging";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import type { Fcm } from "../src/push.js";
import { sendeAbsagePush, sendeAenderungsPush } from "../src/termin-push.js";
import { fcmNachricht } from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import { legeProgrammAn } from "./hilfen/programme.js";

const sql = postgres(API_URL);
const db = erstelleDb(sql);
afterAll(() => sql.end());

// Die Attrappe merkt sich nur die Tokens dieser Datei: Die Datenbank teilen sich alle Testdateien
let nachrichten: TokenMessage[];
const tokens = new Map<string, string>();
let ausfall = false;
const fcm: Fcm = {
  async sendEach(liste) {
    if (ausfall)
      throw Object.assign(new Error("Fehler"), {
        code: "messaging/internal-error",
      });
    nachrichten.push(...liste.filter((n) => tokens.has(n.token)));
    return { responses: liste.map(() => ({ success: true })) };
  },
};
beforeEach(() => {
  nachrichten = [];
  ausfall = false;
});

// Eine eigene Einheit pro Test
async function neueWelt() {
  const [bezirk] = await db
    .insert(schema.bezirk)
    .values({ name: `Termin-Push ${randomUUID()}` })
    .returning();
  const [einheit] = await db
    .insert(schema.einheit)
    .values({ bezirkId: bezirk!.id, typ: "jf", name: "Termin-Push" })
    .returning();

  // Ein Konto mit Push-Token; Name = Schlüssel in tokens
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
    return { id: k!.id, token };
  }

  async function person(
    eltern: string[],
    einheitId: string = einheit!.id,
    inaktivSeit: Date | null = null,
  ) {
    const [t] = await db
      .insert(schema.teilnehmende)
      .values({
        einheitId,
        vorname: "Vorname",
        nachname: "Nachname",
        inaktivSeit,
      })
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
      ...optionen,
    });

  const empfaenger = () => nachrichten.map((n) => tokens.get(n.token)!).sort();

  return { einheit: einheit!, konto, person, programm, empfaenger };
}

describe("Absage-Push", () => {
  test("geht an alle Aktiven der Einheit, auch ohne Antwort, mit Text ohne Inhalte und Namen", async () => {
    const w = await neueWelt();
    const andere = await neueWelt();
    const p = await w.programm();
    const ohneAntwort = await w.konto("ohneAntwort");
    const ja = await w.konto("ja");
    const zwei = await w.konto("zweiKinder");
    const kommando = await w.konto("kommando");
    const leitung = await w.konto("leitung");
    const inaktiv = await w.konto("inaktiv");
    const fremd = await w.konto("fremd");
    const ohneSchalter = await w.konto("ohneSchalter", {
      pushProgramme: false,
    });
    const gesperrt = await w.konto("gesperrt", { banned: true });
    const deaktiviert = await w.konto("deaktiviert", {
      deaktiviertAm: new Date(),
    });
    await w.person([ohneAntwort.id]);
    const tJa = await w.person([ja.id]);
    await w.person([zwei.id]);
    await w.person([zwei.id]);
    await w.person([inaktiv.id], w.einheit.id, new Date());
    await andere.person([fremd.id], andere.einheit.id);
    await w.person([ohneSchalter.id]);
    await w.person([gesperrt.id]);
    await w.person([deaktiviert.id]);
    await db.insert(schema.teilnahme).values({
      programmId: p.id,
      teilnehmendeId: tJa,
      status: "ja",
    });
    await db.insert(schema.einheitRolle).values([
      { userId: kommando.id, einheitId: w.einheit.id, typ: "kommandant" },
      { userId: leitung.id, einheitId: w.einheit.id, typ: "leitung" },
    ]);

    await sendeAbsagePush({ db, fcm }, p.id);

    expect(w.empfaenger()).toEqual([
      "ja",
      "kommando",
      "leitung",
      "ohneAntwort",
      "zweiKinder",
    ]);
    expect(nachrichten[0]).toStrictEqual(
      fcmNachricht(
        nachrichten[0]!.token,
        "Termin abgesagt",
        { typ: "programm", id: p.id },
        "termine",
        "In Fire-Response",
      ),
    );
    // Weder Titel noch Name im Push
    expect(JSON.stringify(nachrichten)).not.toMatch(/Waldtag|Vorname|Nachname/);
  });

  test("ein begonnenes oder unbekanntes Programm löst nichts aus", async () => {
    const w = await neueWelt();
    const eltern = await w.konto("eltern");
    await w.person([eltern.id]);
    const begonnen = await w.programm({
      beginn: new Date("2020-01-01T10:00:00Z"),
    });

    await sendeAbsagePush({ db, fcm }, begonnen.id);
    await sendeAbsagePush({ db, fcm }, randomUUID());

    expect(nachrichten).toEqual([]);
  });

  test("ohne FCM und bei einem Ausfall von FCM wirft sie nicht", async () => {
    const w = await neueWelt();
    const eltern = await w.konto("eltern");
    await w.person([eltern.id]);
    const p = await w.programm();

    await expect(sendeAbsagePush({ db }, p.id)).resolves.toBeUndefined();
    ausfall = true;
    await expect(sendeAbsagePush({ db, fcm }, p.id)).resolves.toBeUndefined();
    await expect(
      sendeAbsagePush({ db, fcm }, "keine-uuid"),
    ).resolves.toBeUndefined();
  });
});

describe("Änderungs-Push", () => {
  test("geht nur an Personen, die schon geantwortet haben (ja oder nein)", async () => {
    const w = await neueWelt();
    const andere = await neueWelt();
    const p = await w.programm();
    const anderes = await w.programm({ titel: "Anderer Tag" });
    const ja = await w.konto("ja");
    const nein = await w.konto("nein");
    const offen = await w.konto("offen");
    const nurAnderes = await w.konto("nurAnderesProgramm");
    const gemischt = await w.konto("gemischt");
    const inaktiv = await w.konto("inaktiv");
    const ohneSchalter = await w.konto("ohneSchalter", {
      pushProgramme: false,
    });
    const kommandoJa = await w.konto("kommandoJa");
    const kommandoOffen = await w.konto("kommandoOffen");
    const fremd = await w.konto("fremd");
    const tJa = await w.person([ja.id]);
    const tNein = await w.person([nein.id]);
    await w.person([offen.id]);
    const tAnderes = await w.person([nurAnderes.id]);
    // Ein Kind hat geantwortet, das zweite nicht: Das Konto bekommt den Push einmal
    const tGemischt = await w.person([gemischt.id]);
    await w.person([gemischt.id]);
    const tInaktiv = await w.person([inaktiv.id], w.einheit.id, new Date());
    const tSchalter = await w.person([ohneSchalter.id]);
    const tFremd = await andere.person([fremd.id], andere.einheit.id);
    await db.insert(schema.teilnahme).values([
      { programmId: p.id, teilnehmendeId: tJa, status: "ja" },
      { programmId: p.id, teilnehmendeId: tNein, status: "nein" },
      { programmId: anderes.id, teilnehmendeId: tAnderes, status: "ja" },
      { programmId: p.id, teilnehmendeId: tGemischt, status: "ja" },
      { programmId: p.id, teilnehmendeId: tInaktiv, status: "ja" },
      { programmId: p.id, teilnehmendeId: tSchalter, status: "ja" },
      { programmId: p.id, teilnehmendeId: tFremd, status: "ja" },
    ]);
    await db.insert(schema.einheitRolle).values([
      { userId: kommandoJa.id, einheitId: w.einheit.id, typ: "kommandant" },
      { userId: kommandoOffen.id, einheitId: w.einheit.id, typ: "leitung" },
    ]);
    await db.insert(schema.leitungAnmeldung).values({
      programmId: p.id,
      userId: kommandoJa.id,
      status: "ja",
    });

    await sendeAenderungsPush({ db, fcm }, p.id);

    expect(w.empfaenger()).toEqual(["gemischt", "ja", "kommandoJa", "nein"]);
    expect(nachrichten[0]).toStrictEqual(
      fcmNachricht(
        nachrichten[0]!.token,
        "Termin geändert",
        { typ: "programm", id: p.id },
        "termine",
        "In Fire-Response",
      ),
    );
    expect(JSON.stringify(nachrichten)).not.toMatch(/Waldtag|Vorname|Nachname/);
  });

  test("hat noch niemand geantwortet, geschieht nichts", async () => {
    const w = await neueWelt();
    const eltern = await w.konto("eltern");
    const kommando = await w.konto("kommando");
    await w.person([eltern.id]);
    await db.insert(schema.einheitRolle).values({
      userId: kommando.id,
      einheitId: w.einheit.id,
      typ: "kommandant",
    });
    const p = await w.programm();

    await sendeAenderungsPush({ db, fcm }, p.id);

    expect(nachrichten).toEqual([]);
  });

  test("ein begonnenes Programm löst nichts aus", async () => {
    const w = await neueWelt();
    const eltern = await w.konto("eltern");
    const t = await w.person([eltern.id]);
    const begonnen = await w.programm({
      beginn: new Date("2020-01-01T10:00:00Z"),
    });
    await db.insert(schema.teilnahme).values({
      programmId: begonnen.id,
      teilnehmendeId: t,
      status: "ja",
    });

    await sendeAenderungsPush({ db, fcm }, begonnen.id);

    expect(nachrichten).toEqual([]);
  });
});
