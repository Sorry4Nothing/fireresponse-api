import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { TokenMessage } from "firebase-admin/messaging";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { inhaltHash, SPERRE_LODUR, syncLodur } from "../src/lodur-sync.js";
import {
  ZWECK_LODUR_LINK,
  type Abruf,
  type Aufloesen,
} from "../src/lodur-url.js";
import type { Fcm } from "../src/push.js";
import { verschluessele } from "../src/startpasswort.js";
import { API_URL } from "./hilfen/datenbank.js";

const sql = postgres(API_URL);
const db = erstelleDb(sql);
afterAll(() => sql.end());

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
  nachrichten = [];
});
afterEach(() => ausgabe.mockRestore());

const HOST = "kalender.example.org";
const HOSTS = [HOST];
// Feste Zeit, nie die Uhr: Termine vor dem 2. November 2026 sind vergangen, danach künftig
const JETZT = new Date("2026-11-02T12:00:00Z");
// Kein Test geht ins Netz: Der Host löst auf eine öffentliche Adresse auf
const OEFFENTLICH: Aufloesen = async () => ["93.184.216.34"];
const LINK = `https://${HOST}/ical/geheim-${randomUUID()}`;

let nachrichten: TokenMessage[];
const tokens = new Map<string, string>();
const fcm: Fcm = {
  async sendEach(liste) {
    nachrichten.push(...liste);
    return { responses: liste.map(() => ({ success: true })) };
  },
};
// Die Namen der Konten, die einen Push bekamen, sortiert
const empfaenger = () => nachrichten.map((n) => tokens.get(n.token)!).sort();

const KOPF = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Beispiel//DE"];
// Erfundene Kalender im Schema von Lodur: DTSTAMP, CREATED und LAST-MODIFIED sind der Abrufzeitpunkt
function kalender(
  ereignisse: {
    uid: string;
    start: string;
    titel?: string;
    thema?: string;
    aufgebot?: string;
  }[],
  abruf = "20261102T120000Z",
) {
  return [
    ...KOPF,
    ...ereignisse.flatMap((e) => [
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `DTSTAMP:${abruf}`,
      `CREATED:${abruf}`,
      `LAST-MODIFIED:${abruf}`,
      `DTSTART:${e.start}`,
      `DTEND:${e.start.replace(/T\d{2}/, "T20")}`,
      `SUMMARY:${e.titel ?? "Übung"}\\n`,
      "LOCATION:",
      `DESCRIPTION:Thema/Dienst: ${e.thema ?? "Allgemein"}\\nInfo: ohne\\nVerantwortlich: Erfundene Person\\nAufgebot: ${e.aufgebot ?? "18:00"}`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

const ZUKUNFT = { uid: "z1", start: "20261114T180000Z" };
const VERGANGEN = { uid: "v1", start: "20261020T180000Z" };

async function neueWelt(link: string | null = LINK) {
  const [bezirk] = await db
    .insert(schema.bezirk)
    .values({ name: `Sync ${randomUUID()}` })
    .returning();
  const [e] = await db
    .insert(schema.einheit)
    .values({
      bezirkId: bezirk!.id,
      typ: "jf",
      name: "Sync",
      lodurUrlVerschluesselt: link && verschluessele(link, ZWECK_LODUR_LINK),
    })
    .returning();

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
  async function person(eltern: string[], inaktivSeit: Date | null = null) {
    const [t] = await db
      .insert(schema.teilnehmende)
      .values({
        einheitId: e!.id,
        vorname: "Person",
        nachname: "Test",
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
  const programme = () =>
    db
      .select()
      .from(schema.programm)
      .where(eq(schema.programm.einheitId, e!.id));
  const einheit = async () =>
    (
      await db.select().from(schema.einheit).where(eq(schema.einheit.id, e!.id))
    )[0]!;
  const lauf = (
    text: string | (() => Response),
    optionen: {
      jetzt?: Date;
      hosts?: string[];
      aufloesen?: Aufloesen;
    } = {},
  ) => {
    const abruf: Abruf = vi.fn(async () =>
      typeof text === "string" ? new Response(text) : text(),
    );
    return syncLodur({
      datenbankUrl: API_URL,
      einheitIds: [e!.id],
      erlaubteHosts: optionen.hosts ?? HOSTS,
      fcm,
      abruf,
      aufloesen: optionen.aufloesen ?? OEFFENTLICH,
      jetzt: optionen.jetzt ?? JETZT,
    }).then((ergebnis) => ({ ergebnis, abruf }));
  };
  const aktuell = async (uid: string) =>
    (await programme()).find((p) => p.googleEventId === uid)!;
  return {
    einheit: e!,
    konto,
    person,
    programme,
    lauf,
    aktuell,
    einheitZeile: einheit,
  };
}

describe("Sync einer Einheit", () => {
  test("übernimmt neue Termine samt Hash, ohne «Verantwortlich», und meldet den Erfolg", async () => {
    const w = await neueWelt();
    const { ergebnis, abruf } = await w.lauf(kalender([ZUKUNFT, VERGANGEN]));
    expect(ergebnis).toBe("fertig");
    expect(abruf).toHaveBeenCalledTimes(1);
    // Vergangene Termine kommen beim ersten Abruf mit: Die Auswertung braucht sie
    const zeilen = await w.programme();
    expect(zeilen.map((z) => z.googleEventId).sort()).toEqual(["v1", "z1"]);
    const z = await w.aktuell("z1");
    expect(z).toMatchObject({
      titel: "Übung",
      status: "aktiv",
      ganztaegig: false,
      beginn: new Date("2026-11-14T18:00:00Z"),
      ende: new Date("2026-11-14T20:00:00Z"),
      thema: "Allgemein",
      info: "ohne",
      aufgebot: "18:00",
      googleOrt: null,
    });
    expect(z.inhaltHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(zeilen)).not.toContain("Erfundene Person");
    const e = await w.einheitZeile();
    expect(e.syncOkAm).toEqual(JETZT);
    expect(e.syncFehler).toBeNull();
    expect(nachrichten).toHaveLength(0);
  });

  test("ein neuer Abruf mit anderem DTSTAMP, CREATED und LAST-MODIFIED ändert nichts", async () => {
    const w = await neueWelt();
    const eltern = await w.konto("eltern");
    const kind = await w.person([eltern]);
    await w.lauf(kalender([ZUKUNFT]));
    const vorher = await w.aktuell("z1");
    await db.insert(schema.teilnahme).values({
      programmId: vorher.id,
      teilnehmendeId: kind,
      status: "ja",
    });
    await w.lauf(kalender([ZUKUNFT], "20261102T123000Z"), {
      jetzt: new Date("2026-11-02T12:30:00Z"),
    });
    expect(await w.aktuell("z1")).toEqual(vorher);
    expect(nachrichten).toHaveLength(0);
  });

  test("ändert sich ein künftiger Termin ohne Antworten, wird er still übernommen", async () => {
    const w = await neueWelt();
    const offen = await w.konto("offen");
    await w.person([offen]);
    await w.lauf(kalender([ZUKUNFT]));
    const id = (await w.aktuell("z1")).id;
    await w.lauf(
      kalender([{ ...ZUKUNFT, start: "20261114T190000Z", thema: "Funk" }]),
    );
    expect(await w.aktuell("z1")).toMatchObject({
      id,
      beginn: new Date("2026-11-14T19:00:00Z"),
      thema: "Funk",
    });
    expect(nachrichten).toHaveLength(0);
  });

  test("mit Antworten: übernommen, Antworten bleiben, Push nur an alle, die geantwortet haben", async () => {
    const w = await neueWelt();
    const [mutter, vater, fremd, kommando, ausgeschaltet, ohnePush] =
      await Promise.all([
        w.konto("mutter"),
        w.konto("vater"),
        w.konto("fremd"),
        w.konto("kommando"),
        w.konto("ausgeschaltet", { pushProgramme: false }),
        w.konto("ohne-antwort"),
      ]);
    const kind = await w.person([mutter, vater]);
    await w.person([fremd]);
    const kind3 = await w.person([ausgeschaltet]);
    await w.person([ohnePush]);
    await db
      .insert(schema.einheitRolle)
      .values({ userId: kommando, einheitId: w.einheit.id, typ: "kommandant" });
    await w.lauf(kalender([ZUKUNFT]));
    const { id } = await w.aktuell("z1");
    await db.insert(schema.teilnahme).values([
      { programmId: id, teilnehmendeId: kind, status: "ja" },
      { programmId: id, teilnehmendeId: kind3, status: "nein" },
    ]);
    await db
      .insert(schema.leitungAnmeldung)
      .values({ programmId: id, userId: kommando, status: "ja" });

    // Der Push nennt weder Datum noch Inhalt
    await w.lauf(
      kalender([{ ...ZUKUNFT, start: "20261115T180000Z", aufgebot: "17:30" }]),
    );

    expect(await w.aktuell("z1")).toMatchObject({ aufgebot: "17:30" });
    const antworten = await db
      .select()
      .from(schema.teilnahme)
      .where(eq(schema.teilnahme.programmId, id));
    expect(antworten).toHaveLength(2);
    // Eltern beider Elternteile und das Kommando, nicht wer nichts geantwortet hat, nicht wer Pushes ausgeschaltet hat
    expect(empfaenger()).toEqual(["kommando", "mutter", "vater"]);
    expect(nachrichten[0]).toMatchObject({
      notification: { title: "Termin geändert", body: "In Fire-Response" },
      data: { typ: "programm", id },
      android: { notification: { channelId: "termine" } },
    });
    // Weder Titel noch Thema noch Name im Push
    expect(JSON.stringify(nachrichten[0])).not.toMatch(
      /Allgemein|Person|Test|17:30/,
    );
  });

  test("vergangene Termine ändert der Sync nie, und fehlen sie im Kalender, bleiben sie aktiv", async () => {
    const w = await neueWelt();
    await w.lauf(kalender([VERGANGEN, ZUKUNFT]));
    const vorher = await w.aktuell("v1");
    await w.lauf(
      kalender([
        { ...VERGANGEN, titel: "Umbenannt", start: "20261021T180000Z" },
        ZUKUNFT,
      ]),
    );
    expect(await w.aktuell("v1")).toEqual(vorher);
    await w.lauf(kalender([ZUKUNFT]));
    expect(await w.aktuell("v1")).toEqual(vorher);
    // Ein Termin, der zum Zeitpunkt des Abrufs schon begonnen hat, zählt als vergangen
    await w.lauf(kalender([ZUKUNFT]), {
      jetzt: new Date("2026-11-14T18:30:00Z"),
    });
    await w.lauf(kalender([{ ...ZUKUNFT, titel: "Zu spät" }]), {
      jetzt: new Date("2026-11-14T18:30:00Z"),
    });
    expect((await w.aktuell("z1")).titel).toBe("Übung");
  });

  test("fehlt die UID eines künftigen Termins, wird er abgesagt: Anmeldungen bleiben, Push an die ganze Einheit", async () => {
    const w = await neueWelt();
    const [mutter, ohneAntwort, kommando, inaktiv] = await Promise.all([
      w.konto("mutter"),
      w.konto("ohne-antwort"),
      w.konto("kommando"),
      w.konto("inaktiv"),
    ]);
    const kind = await w.person([mutter]);
    await w.person([ohneAntwort]);
    await w.person([inaktiv], new Date("2026-01-01T00:00:00Z"));
    await db
      .insert(schema.einheitRolle)
      .values({ userId: kommando, einheitId: w.einheit.id, typ: "kommandant" });
    await w.lauf(kalender([ZUKUNFT, { uid: "z2", start: "20261121T180000Z" }]));
    const { id } = await w.aktuell("z1");
    await db
      .insert(schema.teilnahme)
      .values({ programmId: id, teilnehmendeId: kind, status: "ja" });

    await w.lauf(kalender([{ uid: "z2", start: "20261121T180000Z" }]));

    expect((await w.aktuell("z1")).status).toBe("abgesagt");
    expect((await w.aktuell("z2")).status).toBe("aktiv");
    expect(
      await db
        .select()
        .from(schema.teilnahme)
        .where(eq(schema.teilnahme.programmId, id)),
    ).toHaveLength(1);
    expect(empfaenger()).toEqual(["kommando", "mutter", "ohne-antwort"]);
    expect(nachrichten[0]).toMatchObject({
      notification: { title: "Termin abgesagt", body: "In Fire-Response" },
      data: { typ: "programm", id },
      android: { notification: { channelId: "termine" } },
    });
    // Ein dritter Lauf sagt nicht noch einmal ab
    nachrichten = [];
    await w.lauf(kalender([{ uid: "z2", start: "20261121T180000Z" }]));
    expect(nachrichten).toHaveLength(0);
  });

  test("ein Termin, den wir nicht lesen können, gilt nicht als gestrichen", async () => {
    const w = await neueWelt();
    await w.lauf(kalender([ZUKUNFT]));
    const kaputt = kalender([ZUKUNFT]).replace(
      "DTSTART:20261114T180000Z",
      "DTSTART:bald",
    );
    await w.lauf(kaputt);
    expect((await w.aktuell("z1")).status).toBe("aktiv");
  });

  test("taucht ein abgesagter Termin wieder auf, ist er wieder aktiv", async () => {
    const w = await neueWelt();
    await w.lauf(kalender([ZUKUNFT, { uid: "z2", start: "20261121T180000Z" }]));
    await w.lauf(kalender([{ uid: "z2", start: "20261121T180000Z" }]));
    expect((await w.aktuell("z1")).status).toBe("abgesagt");
    await w.lauf(kalender([ZUKUNFT, { uid: "z2", start: "20261121T180000Z" }]));
    expect((await w.aktuell("z1")).status).toBe("aktiv");
  });

  test("ein leerer Kalender sagt nicht alle künftigen Termine ab", async () => {
    const w = await neueWelt();
    await w.lauf(kalender([ZUKUNFT]));
    await w.lauf(kalender([]));
    expect((await w.aktuell("z1")).status).toBe("aktiv");
    const e = await w.einheitZeile();
    expect(e.syncFehler).toBe("leer");
    // Der Erfolg von vorher bleibt stehen
    expect(e.syncOkAm).toEqual(JETZT);
  });

  test("der Hash deckt die Felder ab, die der Sync übernimmt", () => {
    const basis = {
      uid: "a",
      titel: "T",
      ganztaegig: false,
      beginn: new Date("2026-11-14T18:00:00Z"),
      ende: new Date("2026-11-14T20:00:00Z"),
      tagVon: null,
      tagBis: null,
      thema: "x",
      info: null,
      aufgebot: null,
    };
    const hash = inhaltHash(basis);
    expect(inhaltHash({ ...basis })).toBe(hash);
    for (const aenderung of [
      { titel: "U" },
      { beginn: new Date("2026-11-14T18:01:00Z") },
      { ende: new Date("2026-11-14T20:01:00Z") },
      { thema: "y" },
      { info: "i" },
      { aufgebot: "a" },
    ]) {
      expect(inhaltHash({ ...basis, ...aenderung })).not.toBe(hash);
    }
  });
});

describe("Fehler pro Einheit", () => {
  test.each([
    ["HTTP-Fehler", () => new Response("nein", { status: 500 }), "http-fehler"],
    [
      "Weiterleitung",
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://boese.example.net/" },
        }),
      "weiterleitung",
    ],
    ["kein Kalender", () => new Response("<html></html>"), "kein-kalender"],
  ])(
    "%s: ein Code in der Einheit und im Log, ohne den Link",
    async (_, antwort, erwartet) => {
      const w = await neueWelt();
      await w.lauf(kalender([ZUKUNFT]));
      await w.lauf(antwort);
      const e = await w.einheitZeile();
      expect(e.syncFehler).toBe(erwartet);
      expect(e.syncOkAm).toEqual(JETZT);
      const eintrag = ausgabe.mock.calls
        .map(([z]) => JSON.parse(z as string))
        .find((z) => z.ereignis === "lodur-sync");
      expect(eintrag).toMatchObject({ ereignis: "lodur-sync", code: erwartet });
      expect(JSON.stringify(ausgabe.mock.calls)).not.toContain("geheim");
      // Die Termine bleiben unverändert
      expect((await w.aktuell("z1")).status).toBe("aktiv");
    },
  );

  test("ein Netzwerkfehler nennt nur seinen Code, nicht den Link in der Meldung", async () => {
    const w = await neueWelt();
    await w.lauf(() => {
      throw new TypeError(`fetch failed ${LINK}`);
    });
    expect((await w.einheitZeile()).syncFehler).toBe("netzwerk");
    expect(JSON.stringify(ausgabe.mock.calls)).not.toContain("geheim");
  });

  test("ein Host ausserhalb der Allowlist wird nicht abgerufen", async () => {
    const w = await neueWelt();
    const { abruf } = await w.lauf(kalender([ZUKUNFT]), {
      hosts: ["anderer.example.org"],
    });
    expect(abruf).not.toHaveBeenCalled();
    expect((await w.einheitZeile()).syncFehler).toBe("url-ungueltig");
  });

  test("ein erlaubter Host, der auf eine interne Adresse zeigt, wird nicht abgerufen (SR-26)", async () => {
    const w = await neueWelt();
    const { abruf } = await w.lauf(kalender([ZUKUNFT]), {
      aufloesen: async () => ["93.184.216.34", "10.0.0.5"],
    });
    expect(abruf).not.toHaveBeenCalled();
    expect((await w.einheitZeile()).syncFehler).toBe("url-ungueltig");
    await w.lauf(kalender([ZUKUNFT]), {
      aufloesen: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect((await w.einheitZeile()).syncFehler).toBe("netzwerk");
  });

  test("ein Link, den das Geheimnis nicht mehr öffnet, endet mit «entschluesselung»", async () => {
    const w = await neueWelt();
    await db
      .update(schema.einheit)
      .set({ lodurUrlVerschluesselt: "kein-chiffre" })
      .where(eq(schema.einheit.id, w.einheit.id));
    const { abruf } = await w.lauf(kalender([ZUKUNFT]));
    expect(abruf).not.toHaveBeenCalled();
    expect((await w.einheitZeile()).syncFehler).toBe("entschluesselung");
  });

  test("scheitert die erste Einheit, läuft die zweite trotzdem, und ein Erfolg löscht den Fehler", async () => {
    const a = await neueWelt();
    const b = await neueWelt();
    // Ein eigener Link je Einheit; der Abruf antwortet nach Link
    const antworten = new Map<string, () => Response>();
    for (const w of [a, b]) {
      const link = `https://${HOST}/ical/${w.einheit.id}`;
      antworten.set(link, () => new Response(kalender([ZUKUNFT])));
      await db
        .update(schema.einheit)
        .set({ lodurUrlVerschluesselt: verschluessele(link, ZWECK_LODUR_LINK) })
        .where(eq(schema.einheit.id, w.einheit.id));
    }
    antworten.set(
      `https://${HOST}/ical/${a.einheit.id}`,
      () => new Response("nein", { status: 503 }),
    );
    const abruf: Abruf = async (url) => antworten.get(url.href)!();
    const lauf = () =>
      syncLodur({
        datenbankUrl: API_URL,
        einheitIds: [a.einheit.id, b.einheit.id],
        erlaubteHosts: HOSTS,
        fcm,
        abruf,
        aufloesen: OEFFENTLICH,
        jetzt: JETZT,
      });

    expect(await lauf()).toBe("fertig");
    expect(await a.einheitZeile()).toMatchObject({
      syncFehler: "http-fehler",
      syncOkAm: null,
    });
    expect(await b.einheitZeile()).toMatchObject({
      syncFehler: null,
      syncOkAm: JETZT,
    });
    expect(await b.programme()).toHaveLength(1);

    antworten.set(
      `https://${HOST}/ical/${a.einheit.id}`,
      () => new Response(kalender([ZUKUNFT])),
    );
    await lauf();
    expect(await a.einheitZeile()).toMatchObject({
      syncFehler: null,
      syncOkAm: JETZT,
    });
  });

  test("ohne Link wird die Einheit nicht abgerufen", async () => {
    const w = await neueWelt(null);
    const { ergebnis, abruf } = await w.lauf(kalender([ZUKUNFT]));
    expect(ergebnis).toBe("fertig");
    expect(abruf).not.toHaveBeenCalled();
    expect(await w.programme()).toHaveLength(0);
  });
});

describe("Advisory Lock", () => {
  test("ein zweiter Lauf, während einer arbeitet, tut nichts", async () => {
    const w = await neueWelt();
    const halter = postgres(API_URL, { max: 1 });
    try {
      await halter`select pg_advisory_lock(${SPERRE_LODUR})`;
      const { ergebnis, abruf } = await w.lauf(kalender([ZUKUNFT]));
      expect(ergebnis).toBe("gesperrt");
      expect(abruf).not.toHaveBeenCalled();
      await halter`select pg_advisory_unlock(${SPERRE_LODUR})`;
      expect((await w.lauf(kalender([ZUKUNFT]))).ergebnis).toBe("fertig");
    } finally {
      await halter.end();
    }
  });
});
