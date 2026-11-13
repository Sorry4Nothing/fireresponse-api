import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { ladeSeiten } from "../src/seiten.js";
import { bereiteAuthTestsVor, erstelleTestAuth } from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  type Persona,
  type PersonaKonto,
  type Welt,
} from "./hilfen/personas.js";
import { legeProgrammAn } from "./hilfen/programme.js";

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

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

let welt: Welt;
let standard: Partial<Record<Persona, PersonaKonto>>;
const PERSONEN: Persona[] = [
  "kantonsadmin",
  "kommandoJfA",
  "kommandoKfA",
  "kommandoJfB",
  "leitendeJfA",
  "elternKfA",
];
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  standard = Object.fromEntries(
    await Promise.all(
      PERSONEN.map(async (p) => [p, await legePersonaAn(welt, p)]),
    ),
  );
});
const konto = (p: Persona) => standard[p]!;

const sende = (
  wer: PersonaKonto,
  methode: "GET" | "POST" | "PUT",
  pfad: string,
  body?: unknown,
) =>
  app.request(pfad, {
    method: methode,
    headers: { ...wer.headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const tnPfad = (einheitId: string) =>
  `/api/v1/admin/einheiten/${einheitId}/teilnehmende`;
const uebertrage = (wer: PersonaKonto, von: string, id: string, nach: string) =>
  sende(wer, "POST", `${tnPfad(von)}/${id}/uebertragen`, {
    zielEinheitId: nach,
  });

// Ein Kind der Einheit, das die Eltern der Persona «elternKfA» verantworten; mit Rang, wenn angegeben
async function kind(einheitId: string, rangId?: string) {
  const [zeile] = await db
    .insert(schema.teilnehmende)
    .values({
      einheitId,
      vorname: "Uebertrag",
      nachname: randomUUID().slice(0, 8),
      rangId,
    })
    .returning({ id: schema.teilnehmende.id });
  await db.insert(schema.teilnehmendeKonto).values({
    userId: konto("elternKfA").id!,
    teilnehmendeId: zeile.id,
    art: "eltern",
  });
  return zeile.id;
}

async function einheitVon(id: string) {
  const [zeile] = await db
    .select({
      einheitId: schema.teilnehmende.einheitId,
      rangId: schema.teilnehmende.rangId,
    })
    .from(schema.teilnehmende)
    .where(eq(schema.teilnehmende.id, id));
  return zeile;
}

async function rangAn(einheitId: string, typ: "kf" | "jf", name: string) {
  const [zeile] = await db
    .insert(schema.rang)
    .values({
      einheitId,
      typ,
      name,
      kuerzel: name.slice(0, 2),
      reihenfolge: Math.floor(Math.random() * 900) + 50,
    })
    .returning({ id: schema.rang.id });
  return zeile.id;
}

// Eine Einheit ohne Kommando-Konto: in der App nicht registriert
async function unregistrierteEinheit() {
  const [bezirk] = await db
    .insert(schema.bezirk)
    .values({ name: `Ohne Kommando ${randomUUID().slice(0, 8)}` })
    .returning({ id: schema.bezirk.id });
  const [zeile] = await db
    .insert(schema.einheit)
    .values({ bezirkId: bezirk.id, typ: "jf", name: "Ohne Kommando" })
    .returning({ id: schema.einheit.id });
  return zeile.id;
}

describe("Ziele", () => {
  const ziele = async (wer: PersonaKonto, von: string) => {
    const antwort = await sende(wer, "GET", `${tnPfad(von)}/ziele`);
    expect(antwort.status).toBe(200);
    return ((await antwort.json()).ziele as { id: string }[]).map((z) => z.id);
  };

  test("das Kommando der KF kennt nur die JF desselben Bezirks", async () => {
    expect(await ziele(konto("kommandoKfA"), welt.einheit.kfA)).toEqual([
      welt.einheit.jfA,
    ]);
  });

  test("das Kommando der JF hat keine Ziele", async () => {
    expect(await ziele(konto("kommandoJfA"), welt.einheit.jfA)).toEqual([]);
  });

  test("der Kantonsadmin sieht alle registrierten Einheiten ausser der eigenen, nie eine ohne Kommando", async () => {
    const ohne = await unregistrierteEinheit();
    const ids = await ziele(konto("kantonsadmin"), welt.einheit.kfA);
    expect(ids).toContain(welt.einheit.jfA);
    expect(ids).toContain(welt.einheit.jfB);
    expect(ids).not.toContain(welt.einheit.kfA);
    expect(ids).not.toContain(ohne);
  });

  test("ein deaktiviertes Kommando macht die Einheit unregistriert", async () => {
    const [{ userId }] = await db
      .select({ userId: schema.einheitRolle.userId })
      .from(schema.einheitRolle)
      .where(
        and(
          eq(schema.einheitRolle.einheitId, welt.einheit.jfB),
          eq(schema.einheitRolle.typ, "kommandant"),
        ),
      );
    await db
      .update(schema.user)
      .set({ banned: true, deaktiviertAm: new Date() })
      .where(eq(schema.user.id, userId));
    try {
      expect(
        await ziele(konto("kantonsadmin"), welt.einheit.kfA),
      ).not.toContain(welt.einheit.jfB);
    } finally {
      await db
        .update(schema.user)
        .set({ banned: false, deaktiviertAm: null })
        .where(eq(schema.user.id, userId));
    }
  });

  test("Leitende und Eltern dürfen die Ziele nicht lesen; wer die Einheit nicht sieht, bekommt 404", async () => {
    const pfad = `${tnPfad(welt.einheit.kfA)}/ziele`;
    expect((await sende(konto("elternKfA"), "GET", pfad)).status).toBe(403);
    expect((await sende(konto("leitendeJfA"), "GET", pfad)).status).toBe(404);
    expect((await sende(konto("kommandoJfA"), "GET", pfad)).status).toBe(404);
  });
});

describe("Übertragen", () => {
  test("KF nach JF desselben Bezirks: die Eltern sehen das Kind in der neuen Einheit, Antworten der alten verfallen", async () => {
    const eltern = konto("elternKfA");
    const rangKf = await rangAn(welt.einheit.kfA, "kf", "Kind-Rang");
    const id = await kind(welt.einheit.kfA, rangKf);
    const altesProgramm = await legeProgrammAn(db, {
      einheitId: welt.einheit.kfA,
      beginn: new Date(Date.now() + 10 * 86_400_000),
    });
    const neuesProgramm = await legeProgrammAn(db, {
      einheitId: welt.einheit.jfA,
      beginn: new Date(Date.now() + 10 * 86_400_000),
    });
    const antworte = (programmId: string) =>
      sende(eltern, "PUT", `/api/v1/programme/${programmId}/teilnahmen/${id}`, {
        status: "ja",
      });
    expect((await antworte(altesProgramm.id)).status).toBe(204);
    // Auch eine vergangene Antwort: Sie bliebe sonst ohne Einheit liegen, in keiner Auswertung mehr sichtbar
    const vergangen = await legeProgrammAn(db, {
      einheitId: welt.einheit.kfA,
      beginn: new Date("2026-01-10T13:00:00Z"),
    });
    await db
      .insert(schema.teilnahme)
      .values({ programmId: vergangen.id, teilnehmendeId: id, status: "ja" });

    const antwort = await uebertrage(
      konto("kommandoKfA"),
      welt.einheit.kfA,
      id,
      welt.einheit.jfA,
    );
    expect(antwort.status).toBe(204);

    // Das Kind ist in der neuen Einheit; der Rang der KF gibt es dort nicht
    expect(await einheitVon(id)).toEqual({
      einheitId: welt.einheit.jfA,
      rangId: null,
    });
    expect(
      await db
        .select()
        .from(schema.teilnahme)
        .where(eq(schema.teilnahme.teilnehmendeId, id)),
    ).toEqual([]);

    // GET /ich zeigt die neue Einheit; das Eltern-Konto hat dort keine Rolle und behält den Zugriff über das Kind
    const profil = await (await sende(eltern, "GET", "/api/v1/ich")).json();
    expect(profil.teilnehmende).toContainEqual(
      expect.objectContaining({
        id,
        einheitId: welt.einheit.jfA,
        einheitName: "JF A",
        einheitTyp: "jf",
      }),
    );
    expect(profil.einheiten).toEqual([]);
    expect((await antworte(neuesProgramm.id)).status).toBe(204);
    // Die alte Einheit ist für dieses Kind abgeschlossen: kein Antworten mehr dort
    expect((await antworte(altesProgramm.id)).status).toBe(404);
    const liste = await (
      await sende(
        eltern,
        "GET",
        "/api/v1/programme?von=2020-01-01&bis=2099-12-31",
      )
    ).json();
    // Die Eltern haben in der KF noch ein anderes Kind und sehen deren Programm; dieses Kind steht dort nicht mehr
    const kinderVon = (programmId: string) =>
      (
        liste.programme.find((p: { id: string }) => p.id === programmId)
          ?.teilnehmende ?? []
      ).map((t: { id: string }) => t.id);
    expect(kinderVon(neuesProgramm.id)).toContain(id);
    expect(kinderVon(altesProgramm.id)).not.toContain(id);

    // Verwaltung: weg aus der alten, in der neuen Liste
    const alt = await (
      await sende(konto("kommandoKfA"), "GET", tnPfad(welt.einheit.kfA))
    ).json();
    expect(alt.teilnehmende.map((t: { id: string }) => t.id)).not.toContain(id);
    const neu = await (
      await sende(konto("kommandoJfA"), "GET", tnPfad(welt.einheit.jfA))
    ).json();
    expect(neu.teilnehmende.map((t: { id: string }) => t.id)).toContain(id);
    // Das Konto bleibt verknüpft
    expect(
      neu.teilnehmende.find((t: { id: string }) => t.id === id).konten,
    ).toHaveLength(1);
  });

  test("das Protokoll nennt abgebende und Zieleinheit, Kind-ID und Zahl der Antworten, nie einen Namen", async () => {
    const id = await kind(welt.einheit.kfA);
    const programm = await legeProgrammAn(db, { einheitId: welt.einheit.kfA });
    await db
      .insert(schema.teilnahme)
      .values({ programmId: programm.id, teilnehmendeId: id, status: "nein" });
    expect(
      (
        await uebertrage(
          konto("kommandoKfA"),
          welt.einheit.kfA,
          id,
          welt.einheit.jfA,
        )
      ).status,
    ).toBe(204);
    const [eintrag] = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.zielId, id),
          eq(schema.auditLog.aktion, "teilnehmende_uebertragen"),
        ),
      );
    expect(eintrag).toMatchObject({
      einheitId: welt.einheit.kfA,
      akteurId: konto("kommandoKfA").id,
      zielTyp: "teilnehmende",
      details: {
        vonEinheitId: welt.einheit.kfA,
        nachEinheitId: welt.einheit.jfA,
        geloeschteAntworten: 1,
      },
    });
    expect(JSON.stringify(eintrag)).not.toContain("Uebertrag");
  });

  test("der Kantonsadmin überträgt in einen anderen Bezirk; der gleichnamige Rang des gleichen Typs geht mit, ein fehlender wird leer", async () => {
    const gleich = await rangAn(welt.einheit.jfA, "jf", "Gleicher Rang");
    await rangAn(welt.einheit.jfB, "jf", "Gleicher Rang");
    const einzig = await rangAn(welt.einheit.jfA, "jf", "Nur in A");
    const mit = await kind(welt.einheit.jfA, gleich);
    const ohne = await kind(welt.einheit.jfA, einzig);
    for (const id of [mit, ohne]) {
      expect(
        (
          await uebertrage(
            konto("kantonsadmin"),
            welt.einheit.jfA,
            id,
            welt.einheit.jfB,
          )
        ).status,
      ).toBe(204);
    }
    const rangMit = await einheitVon(mit);
    expect(rangMit.einheitId).toBe(welt.einheit.jfB);
    const [rang] = await db
      .select()
      .from(schema.rang)
      .where(eq(schema.rang.id, rangMit.rangId!));
    expect(rang).toMatchObject({
      einheitId: welt.einheit.jfB,
      name: "Gleicher Rang",
    });
    expect(await einheitVon(ohne)).toEqual({
      einheitId: welt.einheit.jfB,
      rangId: null,
    });
  });

  test("das Kommando der KF darf nicht in einen anderen Bezirk oder in die KF eines anderen Bezirks (403), nichts ändert sich", async () => {
    const id = await kind(welt.einheit.kfA);
    for (const ziel of [welt.einheit.jfB, welt.einheit.kfB]) {
      expect(
        (await uebertrage(konto("kommandoKfA"), welt.einheit.kfA, id, ziel))
          .status,
      ).toBe(403);
    }
    expect((await einheitVon(id)).einheitId).toBe(welt.einheit.kfA);
  });

  test("das Kommando der JF darf nie übertragen (403), auch nicht innerhalb des Bezirks", async () => {
    const id = await kind(welt.einheit.jfA);
    for (const ziel of [welt.einheit.kfA, welt.einheit.jfB]) {
      expect(
        (await uebertrage(konto("kommandoJfA"), welt.einheit.jfA, id, ziel))
          .status,
      ).toBe(403);
    }
    expect((await einheitVon(id)).einheitId).toBe(welt.einheit.jfA);
  });

  test("Leitende und Eltern: 403; eine Person einer anderen Einheit in der URL: 404", async () => {
    const id = await kind(welt.einheit.kfA);
    const von = welt.einheit.kfA;
    expect(
      (await uebertrage(konto("elternKfA"), von, id, welt.einheit.jfA)).status,
    ).toBe(403);
    expect(
      (await uebertrage(konto("leitendeJfA"), von, id, welt.einheit.jfA))
        .status,
    ).toBe(404);
    // IDOR: Die URL nennt JF A, die Person gehört zu KF A
    expect(
      (
        await uebertrage(
          konto("kantonsadmin"),
          welt.einheit.jfA,
          id,
          welt.einheit.jfB,
        )
      ).status,
    ).toBe(404);
    expect((await einheitVon(id)).einheitId).toBe(von);
  });

  test("ungültige Ziele: unbekannt, eigene Einheit, ohne Kommando-Konto, fremde Felder sind 400 für den Kantonsadmin", async () => {
    const id = await kind(welt.einheit.kfA);
    const admin = konto("kantonsadmin");
    for (const ziel of [
      randomUUID(),
      welt.einheit.kfA,
      await unregistrierteEinheit(),
    ]) {
      expect((await uebertrage(admin, welt.einheit.kfA, id, ziel)).status).toBe(
        400,
      );
    }
    const fremd = await sende(
      admin,
      "POST",
      `${tnPfad(welt.einheit.kfA)}/${id}/uebertragen`,
      { zielEinheitId: welt.einheit.jfA, rangId: randomUUID() },
    );
    expect(fremd.status).toBe(400);
    expect((await einheitVon(id)).einheitId).toBe(welt.einheit.kfA);
  });

  test("ohne Kommando-Konto ist auch die JF desselben Bezirks kein Ziel für das Kommando der KF", async () => {
    const id = await kind(welt.einheit.kfA);
    const [{ userId }] = await db
      .select({ userId: schema.einheitRolle.userId })
      .from(schema.einheitRolle)
      .where(
        and(
          eq(schema.einheitRolle.einheitId, welt.einheit.jfA),
          eq(schema.einheitRolle.typ, "kommandant"),
        ),
      );
    await db
      .update(schema.user)
      .set({ deaktiviertAm: new Date() })
      .where(eq(schema.user.id, userId));
    try {
      expect(
        (
          await uebertrage(
            konto("kommandoKfA"),
            welt.einheit.kfA,
            id,
            welt.einheit.jfA,
          )
        ).status,
      ).toBe(403);
    } finally {
      await db
        .update(schema.user)
        .set({ deaktiviertAm: null })
        .where(eq(schema.user.id, userId));
    }
    expect((await einheitVon(id)).einheitId).toBe(welt.einheit.kfA);
  });
});
