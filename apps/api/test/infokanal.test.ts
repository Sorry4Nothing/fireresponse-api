import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import sharp from "sharp";
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
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { loescheAlteMitteilungen } from "../src/infokanal.js";
import { ladeSeiten } from "../src/seiten.js";
import {
  bereiteAuthTestsVor,
  erstelleTestAuth,
  fcmNachricht,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  type Persona,
  type PersonaKonto,
  type Welt,
} from "./hilfen/personas.js";

const fcmAttrappe = bereiteAuthTestsVor();

const sql = postgres(API_URL);
const db = erstelleDb(sql);
const auth = erstelleTestAuth(db);
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  fcm: fcmAttrappe,
  seiten: ladeSeiten(),
});
afterAll(() => sql.end());

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

// Eine Welt pro Test: Die Tests zählen Mitteilungen und Pushes, die Konten dürfen sich nicht teilen
let welt: Welt;
beforeEach(async () => {
  welt = await erstelleWelt(db, auth);
  fcmAttrappe.zuruecksetzen();
});

const person = (persona: Persona) => legePersonaAn(welt, persona);
const jfA = () => welt.einheit.jfA;

const aufruf = (
  konto: PersonaKonto,
  methode: "GET" | "POST" | "PUT" | "DELETE",
  pfad: string,
  body?: unknown,
) =>
  app.request(pfad, {
    method: methode,
    headers:
      body === undefined
        ? konto.headers
        : { ...konto.headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const liste = (konto: PersonaKonto) =>
  aufruf(konto, "GET", "/api/v1/infokanaele");
const verlauf = (konto: PersonaKonto, einheitId = jfA(), abfrage = "") =>
  aufruf(
    konto,
    "GET",
    `/api/v1/infokanaele/${einheitId}/mitteilungen${abfrage}`,
  );
const schreibe = (konto: PersonaKonto, text: unknown, einheitId = jfA()) =>
  aufruf(konto, "POST", `/api/v1/infokanaele/${einheitId}/mitteilungen`, {
    text,
  });
const aendere = (
  konto: PersonaKonto,
  id: string,
  text: unknown,
  einheitId = jfA(),
) =>
  aufruf(konto, "PUT", `/api/v1/infokanaele/${einheitId}/mitteilungen/${id}`, {
    text,
  });
const loesche = (konto: PersonaKonto, id: string, einheitId = jfA()) =>
  aufruf(
    konto,
    "DELETE",
    `/api/v1/infokanaele/${einheitId}/mitteilungen/${id}`,
  );
const gelesen = (konto: PersonaKonto, einheitId = jfA()) =>
  aufruf(konto, "PUT", `/api/v1/infokanaele/${einheitId}/gelesen`);

// Direkt in die Datenbank, ohne Push und ohne Rate-Limit; erstellt steuert die Zeit
async function legeAn(
  autor: PersonaKonto | null,
  text: string,
  { einheitId = jfA(), erstellt }: { einheitId?: string; erstellt?: Date } = {},
) {
  const [zeile] = await db
    .insert(schema.infokanalMitteilung)
    .values({
      einheitId,
      autorId: autor?.id ?? null,
      text,
      ...(erstellt && { erstelltAm: erstellt }),
    })
    .returning({ id: schema.infokanalMitteilung.id });
  return zeile!.id;
}

const mitteilungenVon = (einheitId: string) =>
  db
    .select()
    .from(schema.infokanalMitteilung)
    .where(eq(schema.infokanalMitteilung.einheitId, einheitId));

// Ein Token pro Konto, angemeldet über die Route wie in der App
async function token(konto: PersonaKonto) {
  const wert = `fcm-test-${randomUUID()}`;
  const antwort = await aufruf(konto, "PUT", "/api/v1/push-token", {
    token: wert,
    plattform: "android",
  });
  expect(antwort.status).toBe(204);
  return wert;
}

describe("GET /api/v1/infokanaele", () => {
  test("eine Zeile je Einheit mit Rolle oder aktiven Teilnehmenden; schreiben darf nur, wer eine Rolle hat", async () => {
    const [sl, eltern, gemischt, zwei, admin] = await Promise.all([
      person("kommandoJfA"),
      person("elternJfA"),
      person("leitendeJfAElternKfA"),
      person("elternAundB"),
      person("kantonsadmin"),
    ]);
    const kopf = (
      name: string,
      id: string,
      typ: string,
      schreiben: boolean,
    ) => ({
      einheit: { id, name, typ },
      name: `Infokanal ${name}`,
      darfSchreiben: schreiben,
      ungelesen: 0,
      letzteMitteilungAm: null,
    });

    expect(await (await liste(sl)).json()).toEqual({
      infokanaele: [kopf("JF A", jfA(), "jf", true)],
    });
    expect(await (await liste(eltern)).json()).toEqual({
      infokanaele: [kopf("JF A", jfA(), "jf", false)],
    });
    // Leitung in JF A und Elternteil in KF A: je Einheit ein Infokanal, die Rechte je Einheit
    expect(await (await liste(gemischt)).json()).toEqual({
      infokanaele: [
        kopf("JF A", jfA(), "jf", true),
        kopf("KF A", welt.einheit.kfA, "kf", false),
      ],
    });
    expect(await (await liste(zwei)).json()).toEqual({
      infokanaele: [
        kopf("JF A", jfA(), "jf", false),
        kopf("JF B", welt.einheit.jfB, "jf", false),
      ],
    });
    // Das Kantonsadmin-Konto hat keine Einheit und sieht nichts
    expect(await (await liste(admin)).json()).toEqual({ infokanaele: [] });
  });

  test("ein inaktives Kind öffnet keinen Infokanal", async () => {
    const eltern = await person("elternJfA");
    await db
      .update(schema.teilnehmende)
      .set({ inaktivSeit: new Date() })
      .where(eq(schema.teilnehmende.id, welt.teilnehmende.jfA));

    expect(await (await liste(eltern)).json()).toEqual({ infokanaele: [] });
    expect((await verlauf(eltern)).status).toBe(404);
  });

  test("ungelesen zählt weder eigene noch gelöschte Mitteilungen; PUT gelesen setzt den Zähler zurück", async () => {
    const [sl, leitung, eltern] = await Promise.all([
      person("kommandoJfA"),
      person("leitendeJfA"),
      person("elternJfA"),
    ]);
    await legeAn(sl, "eins");
    await legeAn(sl, "zwei");
    await legeAn(leitung, "drei");
    const weg = await legeAn(sl, "vier");
    expect((await loesche(sl, weg)).status).toBe(204);
    const zaehle = async (konto: PersonaKonto) =>
      (await (await liste(konto)).json()).infokanaele[0];

    expect((await zaehle(eltern)).ungelesen).toBe(3);
    // Die eigenen zwei zählen für das Kommando nicht
    expect((await zaehle(sl)).ungelesen).toBe(1);
    expect((await zaehle(eltern)).letzteMitteilungAm).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );

    expect((await gelesen(eltern)).status).toBe(204);
    expect((await zaehle(eltern)).ungelesen).toBe(0);
    // Der Lesestand gilt je Konto
    expect((await zaehle(sl)).ungelesen).toBe(1);

    await legeAn(leitung, "fünf");
    expect((await zaehle(eltern)).ungelesen).toBe(1);
  });
});

describe("GET /api/v1/infokanaele/:einheitId/mitteilungen", () => {
  test("neueste zuerst, seitenweise mit vor, limit und naechste", async () => {
    const [sl, eltern] = await Promise.all([
      person("kommandoJfA"),
      person("elternJfA"),
    ]);
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) ids.push(await legeAn(sl, `Nr ${i}`));

    const erste = await (await verlauf(eltern, jfA(), "?limit=2")).json();
    expect(erste.mitteilungen.map((m: { text: string }) => m.text)).toEqual([
      "Nr 5",
      "Nr 4",
    ]);
    expect(erste.naechste).toBe(ids[3]);
    const zweite = await (
      await verlauf(eltern, jfA(), `?limit=2&vor=${erste.naechste}`)
    ).json();
    expect(zweite.mitteilungen.map((m: { text: string }) => m.text)).toEqual([
      "Nr 3",
      "Nr 2",
    ]);
    const dritte = await (
      await verlauf(eltern, jfA(), `?limit=2&vor=${zweite.naechste}`)
    ).json();
    expect(dritte.mitteilungen.map((m: { text: string }) => m.text)).toEqual([
      "Nr 1",
    ]);
    expect(dritte.naechste).toBeNull();
    // Genau eine volle Seite: kein Rest, kein «naechste»
    const alle = await (await verlauf(eltern, jfA(), "?limit=5")).json();
    expect(alle.mitteilungen).toHaveLength(5);
    expect(alle.naechste).toBeNull();
  });

  test.each([
    "?limit=0",
    "?limit=101",
    "?limit=abc",
    "?limit=",
    "?vor=nicht-uuid",
    "?foo=1",
  ])("ungültige Abfrage %s ergibt 400", async (abfrage) => {
    const eltern = await person("elternJfA");
    expect((await verlauf(eltern, jfA(), abfrage)).status).toBe(400);
  });

  test("Standard 50, höchstens 100 je Seite", async () => {
    const [sl, eltern] = await Promise.all([
      person("kommandoJfA"),
      person("elternJfA"),
    ]);
    await db.insert(schema.infokanalMitteilung).values(
      Array.from({ length: 101 }, (_, i) => ({
        einheitId: jfA(),
        autorId: sl.id,
        text: `Nr ${i}`,
      })),
    );

    const standard = await (await verlauf(eltern)).json();
    expect(standard.mitteilungen).toHaveLength(50);
    expect(standard.naechste).toBe(standard.mitteilungen[49].id);
    const gross = await (await verlauf(eltern, jfA(), "?limit=100")).json();
    expect(gross.mitteilungen).toHaveLength(100);
    expect(gross.naechste).not.toBeNull();
  });

  test("Felder: Autor mit Rolle (Stellvertretung als kommando), Rechte je Person, gelöschte als Platzhalter", async () => {
    const [sl, stv, leitung, eltern] = await Promise.all([
      person("kommandoJfA"),
      person("stellvertretung1JfA"),
      person("leitendeJfA"),
      person("elternJfA"),
    ]);
    const vomKommando = await legeAn(sl, "Vom Kommando");
    const vonStv = await legeAn(stv, "Von der Stellvertretung");
    const vonLeitung = await legeAn(leitung, "Von der Leitung");
    const weg = await legeAn(sl, "Weg");
    await loesche(sl, weg);
    await aendere(leitung, vonLeitung, "Von der Leitung, neu");

    const alsEltern = await (await verlauf(eltern)).json();
    expect(alsEltern.darfSchreiben).toBe(false);
    expect(alsEltern.naechste).toBeNull();
    const nachId = Object.fromEntries(
      alsEltern.mitteilungen.map((m: { id: string }) => [m.id, m]),
    );
    expect(nachId[vomKommando]).toEqual({
      id: vomKommando,
      text: "Vom Kommando",
      geloescht: false,
      bearbeitet: false,
      erstelltAm: expect.stringMatching(/^\d{4}-/),
      autor: { name: expect.any(String), rolle: "kommando", bildUrl: null },
      eigene: false,
      darfBearbeiten: false,
      darfLoeschen: false,
    });
    expect(nachId[vonStv].autor.rolle).toBe("kommando");
    expect(nachId[vonLeitung]).toMatchObject({
      text: "Von der Leitung, neu",
      bearbeitet: true,
      autor: { rolle: "leitung" },
    });
    expect(nachId[weg]).toEqual({
      id: weg,
      text: null,
      geloescht: true,
      bearbeitet: false,
      erstelltAm: expect.any(String),
      autor: null,
      eigene: false,
      darfBearbeiten: false,
      darfLoeschen: false,
    });

    // Das Kommando löscht auch fremde, bearbeitet aber nur eigene; die Leitung nur eigene
    const alsKommando = await (await verlauf(sl)).json();
    expect(alsKommando.darfSchreiben).toBe(true);
    const k = Object.fromEntries(
      alsKommando.mitteilungen.map((m: { id: string }) => [m.id, m]),
    );
    expect(k[vomKommando]).toMatchObject({
      eigene: true,
      darfBearbeiten: true,
      darfLoeschen: true,
    });
    expect(k[vonLeitung]).toMatchObject({
      eigene: false,
      darfBearbeiten: false,
      darfLoeschen: true,
    });
    const alsLeitung = await (await verlauf(leitung)).json();
    const l = Object.fromEntries(
      alsLeitung.mitteilungen.map((m: { id: string }) => [m.id, m]),
    );
    expect(l[vonLeitung]).toMatchObject({
      eigene: true,
      darfBearbeiten: true,
      darfLoeschen: true,
    });
    expect(l[vomKommando]).toMatchObject({
      eigene: false,
      darfBearbeiten: false,
      darfLoeschen: false,
    });
  });

  test("wer die Rolle verloren hat, trägt keine Rolle mehr; die Mitteilung bleibt", async () => {
    const [leitung, eltern] = await Promise.all([
      person("leitendeJfA"),
      person("elternJfA"),
    ]);
    const id = await legeAn(leitung, "Bleibt");
    await db
      .delete(schema.einheitRolle)
      .where(eq(schema.einheitRolle.userId, leitung.id!));

    const [m] = (await (await verlauf(eltern)).json()).mitteilungen;
    expect(m).toMatchObject({ id, text: "Bleibt", autor: { rolle: null } });
    // Die frühere Leitung liest und löscht die eigene, bearbeitet sie aber nicht mehr
    expect((await verlauf(leitung)).status).toBe(404);
  });

  test("Kantonsadmin, fremde und unbekannte Einheit: 404", async () => {
    const [admin, eltern, fremd] = await Promise.all([
      person("kantonsadmin"),
      person("elternJfA"),
      person("kommandoKfA"),
    ]);
    await legeAn(null, "Nur JF A");

    for (const konto of [admin, fremd]) {
      expect((await verlauf(konto)).status).toBe(404);
    }
    expect((await verlauf(eltern, welt.einheit.jfB)).status).toBe(404);
    expect((await verlauf(eltern, randomUUID())).status).toBe(404);
    expect((await verlauf(eltern, "keine-uuid")).status).toBe(400);
  });
});

describe("POST /api/v1/infokanaele/:einheitId/mitteilungen", () => {
  test.each([
    "kommandoJfA",
    "stellvertretung1JfA",
    "leitendeJfA",
    "leitendeJfAElternKfA",
  ] as const)(
    "%s schreibt und bekommt die Mitteilung zurück",
    async (persona) => {
      const konto = await person(persona);

      const antwort = await schreibe(konto, "  Übung fällt aus  ");

      expect(antwort.status).toBe(201);
      expect(await antwort.json()).toMatchObject({
        text: "Übung fällt aus",
        geloescht: false,
        bearbeitet: false,
        eigene: true,
        darfBearbeiten: true,
        darfLoeschen: true,
        autor: { name: expect.any(String), bildUrl: null },
      });
      const zeilen = await db.select().from(schema.infokanalMitteilung);
      expect(
        zeilen.filter((z) => z.einheitId === jfA() && z.autorId === konto.id),
      ).toHaveLength(1);
    },
  );

  test("Eltern und Teilnehmende lesen nur (403), das Kantonsadmin-Konto und fremde Einheiten sind 404", async () => {
    const [eltern, selbst, admin, fremd] = await Promise.all([
      person("elternJfA"),
      person("teilnehmendeSelbstJfA"),
      person("kantonsadmin"),
      person("kommandoKfA"),
    ]);

    expect((await schreibe(eltern, "x")).status).toBe(403);
    expect((await schreibe(selbst, "x")).status).toBe(403);
    expect((await schreibe(admin, "x")).status).toBe(404);
    expect((await schreibe(fremd, "x")).status).toBe(404);
    // Leitung in JF A schreibt nicht in KF A, wo sie nur Elternteil ist
    const gemischt = await person("leitendeJfAElternKfA");
    expect((await schreibe(gemischt, "x", welt.einheit.kfA)).status).toBe(403);
    expect(await mitteilungenVon(jfA())).toEqual([]);
    expect(await mitteilungenVon(welt.einheit.kfA)).toEqual([]);
  });

  test("Text: 1 bis 2000 Zeichen, nur Text", async () => {
    const sl = await person("kommandoJfA");

    expect((await schreibe(sl, "a".repeat(2000))).status).toBe(201);
    // Emojis zählen als ein Zeichen
    expect((await schreibe(sl, "🔥".repeat(2000))).status).toBe(201);
    for (const text of [
      "",
      "   ",
      "a".repeat(2001),
      "🔥".repeat(2001),
      "mit\0Null",
      42,
      null,
      ["a"],
      undefined,
    ]) {
      const antwort = await schreibe(sl, text);
      expect(antwort.status, JSON.stringify(text)).toBe(400);
    }
    const mitFremdFeld = await aufruf(
      sl,
      "POST",
      `/api/v1/infokanaele/${jfA()}/mitteilungen`,
      { text: "x", einheitId: welt.einheit.jfB },
    );
    expect(mitFremdFeld.status).toBe(400);
    expect(await mitteilungenVon(jfA())).toHaveLength(2);
  });

  test("ein Konto schreibt höchstens 20 Mitteilungen in 10 Minuten (429)", async () => {
    const sl = await person("kommandoJfA");
    for (let i = 0; i < 20; i++) {
      expect((await schreibe(sl, `Nr ${i}`)).status).toBe(201);
    }
    expect((await schreibe(sl, "zu viel")).status).toBe(429);
    // Eine andere Person ist nicht betroffen
    const leitung = await person("leitendeJfA");
    expect((await schreibe(leitung, "frei")).status).toBe(201);
  });

  test("Anführungszeichen, Markup und Links bleiben Text und werden nicht verändert", async () => {
    const sl = await person("kommandoJfA");
    const text = `<b>"Hallo"</b> https://example.org/a?b=1&c=2 ' -- ;`;

    const antwort = await schreibe(sl, text);

    expect((await antwort.json()).text).toBe(text);
  });
});

describe("PUT /api/v1/infokanaele/:einheitId/mitteilungen/:id", () => {
  test("die schreibende Person ändert den Text, setzt «bearbeitet» und löst keinen Push aus", async () => {
    const [sl, eltern] = await Promise.all([
      person("kommandoJfA"),
      person("elternJfA"),
    ]);
    await token(eltern);
    const id = await legeAn(sl, "Alt");

    const antwort = await aendere(sl, id, "Neu");

    expect(antwort.status).toBe(200);
    expect(await antwort.json()).toMatchObject({
      id,
      text: "Neu",
      bearbeitet: true,
    });
    expect(fcmAttrappe.nachrichten).toEqual([]);
    expect((await aendere(sl, id, "")).status).toBe(400);
    expect((await aendere(sl, id, "x".repeat(2001))).status).toBe(400);
  });

  test("nur die schreibende Person: Kommando, Leitung und Eltern ändern fremde Mitteilungen nicht (403)", async () => {
    const [sl, stv, leitung, eltern] = await Promise.all([
      person("kommandoJfA"),
      person("stellvertretung1JfA"),
      person("leitendeJfA"),
      person("elternJfA"),
    ]);
    const id = await legeAn(leitung, "Von der Leitung");

    for (const konto of [sl, stv, eltern]) {
      expect((await aendere(konto, id, "Fremd")).status).toBe(403);
    }
    expect((await aendere(leitung, id, "Eigen")).status).toBe(200);
  });

  test("wer die Rolle verloren hat, ändert nicht mehr (403)", async () => {
    const leitung = await person("leitendeJfAElternKfA");
    const id = await legeAn(leitung, "Alt");
    await db
      .delete(schema.einheitRolle)
      .where(eq(schema.einheitRolle.userId, leitung.id!));
    await db
      .insert(schema.teilnehmendeKonto)
      .values({
        userId: leitung.id!,
        teilnehmendeId: welt.teilnehmende.jfA,
        art: "eltern",
      })
      .onConflictDoNothing();

    expect((await aendere(leitung, id, "Neu")).status).toBe(403);
    // Löschen der eigenen bleibt möglich
    expect((await loesche(leitung, id)).status).toBe(204);
  });

  test("gelöschte, fremde und unbekannte Mitteilungen: 404, nie ein Zugriff über eine andere Einheit", async () => {
    const [sl, slB] = await Promise.all([
      person("kommandoJfA"),
      person("kommandoJfB"),
    ]);
    const id = await legeAn(sl, "Text");
    const weg = await legeAn(sl, "Weg");
    await loesche(sl, weg);

    expect((await aendere(sl, weg, "x")).status).toBe(404);
    expect((await aendere(sl, randomUUID(), "x")).status).toBe(404);
    // Die ID gehört zu JF A; über die eigene Einheit ist sie unbekannt, über JF A ist JF B fremd
    expect((await aendere(slB, id, "x", welt.einheit.jfB)).status).toBe(404);
    expect((await aendere(slB, id, "x", jfA())).status).toBe(404);
    expect((await loesche(slB, id, welt.einheit.jfB)).status).toBe(404);
    expect((await loesche(slB, id, jfA())).status).toBe(404);
    const [zeile] = await db
      .select({ text: schema.infokanalMitteilung.text })
      .from(schema.infokanalMitteilung)
      .where(eq(schema.infokanalMitteilung.id, id));
    expect(zeile!.text).toBe("Text");
  });
});

describe("DELETE /api/v1/infokanaele/:einheitId/mitteilungen/:id", () => {
  test("die schreibende Person löscht die eigene; Text und Autor sind in der Datenbank weg, der Platzhalter bleibt", async () => {
    const [leitung, eltern] = await Promise.all([
      person("leitendeJfA"),
      person("elternJfA"),
    ]);
    const id = await legeAn(leitung, "Geheimer Inhalt");

    const antwort = await loesche(leitung, id);

    expect(antwort.status).toBe(204);
    const [zeile] = await db
      .select()
      .from(schema.infokanalMitteilung)
      .where(eq(schema.infokanalMitteilung.id, id));
    expect(zeile).toMatchObject({ text: null, autorId: null });
    expect(zeile!.geloeschtAm).toBeInstanceOf(Date);
    expect(JSON.stringify(zeile)).not.toContain("Geheimer");
    const [platzhalter] = (await (await verlauf(eltern)).json()).mitteilungen;
    expect(platzhalter).toMatchObject({
      id,
      text: null,
      geloescht: true,
      autor: null,
    });
    // Zweimal löschen ergibt 404
    expect((await loesche(leitung, id)).status).toBe(404);
  });

  test("das Kommando und die Stellvertretung löschen auch fremde, die Leitung und Eltern nicht (403)", async () => {
    const [sl, stv, leitung, andere, eltern] = await Promise.all([
      person("kommandoJfA"),
      person("stellvertretung1JfA"),
      person("leitendeJfA"),
      person("leitendeJfAElternKfA"),
      person("elternJfA"),
    ]);
    const id = await legeAn(andere, "Von der anderen Leitung");

    for (const konto of [leitung, eltern]) {
      expect((await loesche(konto, id)).status).toBe(403);
    }
    expect((await loesche(sl, id)).status).toBe(204);
    const zweite = await legeAn(leitung, "Von der Leitung");
    expect((await loesche(stv, zweite)).status).toBe(204);
  });

  test("das Kantonsadmin-Konto und fremde Kommandos löschen nichts (404)", async () => {
    const [admin, fremd, sl] = await Promise.all([
      person("kantonsadmin"),
      person("kommandoKfA"),
      person("kommandoJfA"),
    ]);
    const id = await legeAn(sl, "Bleibt");

    expect((await loesche(admin, id)).status).toBe(404);
    expect((await loesche(fremd, id)).status).toBe(404);
    expect((await loesche(sl, id)).status).toBe(204);
  });
});

describe("PUT /api/v1/infokanaele/:einheitId/gelesen", () => {
  test("alle Konten der Einheit dürfen; fremde und das Kantonsadmin-Konto bekommen 404", async () => {
    const [eltern, sl, admin, fremd] = await Promise.all([
      person("elternJfA"),
      person("kommandoJfA"),
      person("kantonsadmin"),
      person("elternKfA"),
    ]);

    expect((await gelesen(eltern)).status).toBe(204);
    expect((await gelesen(sl)).status).toBe(204);
    // Ein zweites Mal ändert nur die Zeit
    expect((await gelesen(eltern)).status).toBe(204);
    expect((await gelesen(admin)).status).toBe(404);
    expect((await gelesen(fremd)).status).toBe(404);
    const zeilen = await db
      .select()
      .from(schema.infokanalGelesen)
      .where(eq(schema.infokanalGelesen.einheitId, jfA()));
    expect(zeilen.map((z) => z.userId).sort()).toEqual(
      [eltern.id!, sl.id!].sort(),
    );
  });
});

describe("Push bei einer neuen Mitteilung", () => {
  test("geht an alle Konten der Einheit ausser der schreibenden Person, mit Einheitsnamen und ohne Text", async () => {
    const [sl, stv, leitung, eltern, selbst, fremd, admin] = await Promise.all([
      person("kommandoJfA"),
      person("stellvertretung1JfA"),
      person("leitendeJfA"),
      person("elternJfA"),
      person("teilnehmendeSelbstJfA"),
      person("kommandoKfA"),
      person("kantonsadmin"),
    ]);
    const [, tStv, tLeitung, tEltern, tSelbst] = await Promise.all(
      [sl, stv, leitung, eltern, selbst].map(token),
    );
    await Promise.all([fremd, admin].map(token));

    const antwort = await schreibe(sl, "Treffpunkt ist geheim");

    expect(antwort.status).toBe(201);
    expect(fcmAttrappe.nachrichten.map((n) => n.token).sort()).toEqual(
      [tStv, tLeitung, tEltern, tSelbst].sort(),
    );
    expect(fcmAttrappe.nachrichten).toStrictEqual(
      expect.arrayContaining([
        fcmNachricht(
          tEltern,
          "Neue Mitteilung im Infokanal JF A",
          { typ: "infokanal", id: jfA() },
          "infokanal",
        ),
      ]),
    );
    const alles = JSON.stringify(fcmAttrappe.nachrichten);
    expect(alles).not.toContain("Treffpunkt");
    expect(alles).not.toContain(sl.benutzername);
  });

  test("Schalter pushInfokanal aus, inaktives Kind, deaktiviertes Konto: kein Push; pushProgramme gilt nicht", async () => {
    const [sl, eltern, aus, inaktiv, ohneProgramme] = await Promise.all([
      person("kommandoJfA"),
      person("elternJfA"),
      person("elternAundB"),
      person("elternNachWechsel"),
      person("leitendeJfA"),
    ]);
    const [tEltern, , , tOhneProgramme] = await Promise.all(
      [eltern, aus, inaktiv, ohneProgramme].map(token),
    );
    await db
      .update(schema.user)
      .set({ pushInfokanal: false })
      .where(eq(schema.user.id, aus.id!));
    await db
      .update(schema.user)
      .set({ pushProgramme: false })
      .where(eq(schema.user.id, ohneProgramme.id!));
    await db
      .update(schema.teilnehmende)
      .set({ inaktivSeit: new Date() })
      .where(eq(schema.teilnehmende.id, welt.teilnehmende.jfA2));

    await schreibe(sl, "Hallo");

    expect(fcmAttrappe.nachrichten.map((n) => n.token).sort()).toEqual(
      [tEltern, tOhneProgramme].sort(),
    );
  });

  test("ein Konto mit Rolle und Kind in der Einheit bekommt einen Push", async () => {
    const [sl, leitung] = await Promise.all([
      person("kommandoJfA"),
      person("leitendeJfA"),
    ]);
    await db.insert(schema.teilnehmendeKonto).values({
      userId: leitung.id!,
      teilnehmendeId: welt.teilnehmende.jfA2,
      art: "eltern",
    });
    await token(leitung);

    await schreibe(sl, "Hallo");

    expect(fcmAttrappe.nachrichten).toHaveLength(1);
  });

  test("ein Fehler beim Versand lässt die Mitteilung bestehen", async () => {
    const [sl, eltern] = await Promise.all([
      person("kommandoJfA"),
      person("elternJfA"),
    ]);
    await token(eltern);
    fcmAttrappe.ausfall = true;

    const antwort = await schreibe(sl, "Trotzdem da");

    expect(antwort.status).toBe(201);
    const zeilen = await db
      .select()
      .from(schema.infokanalMitteilung)
      .where(eq(schema.infokanalMitteilung.einheitId, jfA()));
    expect(zeilen).toHaveLength(1);
  });

  test("der Text steht in keiner Log-Zeile", async () => {
    const [sl, eltern] = await Promise.all([
      person("kommandoJfA"),
      person("elternJfA"),
    ]);
    await token(eltern);
    fcmAttrappe.ausfall = true;
    const geheim = `Geheim-${randomUUID()}`;

    await schreibe(sl, geheim);
    const id = await legeAn(sl, "x");
    await aendere(sl, id, geheim);
    await loesche(sl, id);
    await verlauf(eltern);

    expect(JSON.stringify(ausgabe.mock.calls)).not.toContain(geheim);
  });
});

describe("GET und PATCH /api/v1/ich: Schalter pushInfokanal", () => {
  test.each(["elternJfA", "kommandoJfA", "kantonsadmin"] as const)(
    "%s: Standard true, ausschalten und einschalten",
    async (persona) => {
      const konto = await person(persona);
      const lies = async () =>
        (await (await aufruf(konto, "GET", "/api/v1/ich")).json())
          .pushInfokanal;
      const setze = (wert: unknown) =>
        app.request("/api/v1/ich", {
          method: "PATCH",
          headers: { ...konto.headers, "content-type": "application/json" },
          body: JSON.stringify({ pushInfokanal: wert }),
        });

      expect(await lies()).toBe(true);
      expect((await setze(false)).status).toBe(204);
      expect(await lies()).toBe(false);
      expect((await setze(true)).status).toBe(204);
      expect(await lies()).toBe(true);
      expect((await setze("nein")).status).toBe(400);
    },
  );
});

describe("Löschen von Konten und Einheiten", () => {
  test("wird das Konto der Autorin gelöscht, bleibt die Mitteilung ohne Autor; der Lesestand geht mit", async () => {
    const [leitung, eltern] = await Promise.all([
      person("leitendeJfA"),
      person("elternJfA"),
    ]);
    await legeAn(leitung, "Bleibt ohne Namen");
    await gelesen(leitung);

    await db.delete(schema.user).where(eq(schema.user.id, leitung.id!));

    const [m] = (await (await verlauf(eltern)).json()).mitteilungen;
    expect(m).toMatchObject({
      text: "Bleibt ohne Namen",
      geloescht: false,
      autor: null,
      eigene: false,
      darfBearbeiten: false,
    });
    expect(m.darfLoeschen).toBe(false);
    expect(
      await db
        .select()
        .from(schema.infokanalGelesen)
        .where(eq(schema.infokanalGelesen.userId, leitung.id!)),
    ).toEqual([]);
  });

  test("das Kommando löscht die Mitteilung eines gelöschten Kontos", async () => {
    const [leitung, sl] = await Promise.all([
      person("leitendeJfA"),
      person("kommandoJfA"),
    ]);
    const id = await legeAn(leitung, "Weg damit");
    await db.delete(schema.user).where(eq(schema.user.id, leitung.id!));

    expect((await loesche(sl, id)).status).toBe(204);
  });
});

describe("automatisches Löschen nach 6 Monaten", () => {
  test("löscht Mitteilungen ab 6 Monaten, auch gelöschte Platzhalter, und lässt jüngere stehen", async () => {
    const sl = await person("kommandoJfA");
    const tage = (n: number) => new Date(Date.now() - n * 86_400_000);
    await legeAn(sl, "Alt", { erstellt: tage(190) });
    const knapp = await legeAn(sl, "Knapp", { erstellt: tage(170) });
    const neu = await legeAn(sl, "Neu");
    const platzhalter = await legeAn(sl, "Platzhalter", {
      erstellt: tage(200),
    });
    await db
      .update(schema.infokanalMitteilung)
      .set({ text: null, autorId: null, geloeschtAm: new Date() })
      .where(eq(schema.infokanalMitteilung.id, platzhalter));

    const anzahl = await loescheAlteMitteilungen(db);

    expect(anzahl).toBeGreaterThanOrEqual(2);
    const uebrig = await db
      .select({ id: schema.infokanalMitteilung.id })
      .from(schema.infokanalMitteilung)
      .where(eq(schema.infokanalMitteilung.einheitId, jfA()));
    expect(uebrig.map((z) => z.id).sort()).toEqual([knapp, neu].sort());
  });
});

describe("Profilbild der Schreibenden", () => {
  test("Eltern sehen das Bild einer Leitung erst, wenn sie dort eine Mitteilung schrieb", async () => {
    const [leitung, eltern, fremd] = await Promise.all([
      person("leitendeJfA"),
      person("elternJfA"),
      person("elternKfA"),
    ]);
    const png = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#3366cc" },
    })
      .jpeg()
      .toBuffer();
    await db
      .insert(schema.profilbild)
      .values({ userId: leitung.id!, inhalt: png });
    const bild = (konto: PersonaKonto) =>
      aufruf(konto, "GET", `/api/v1/personen/${leitung.id}/bild`);

    expect((await bild(eltern)).status).toBe(404);
    const id = await legeAn(leitung, "Mit Bild");
    const [m] = (await (await verlauf(eltern)).json()).mitteilungen;
    expect(m.autor.bildUrl).toMatch(/^\/api\/v1\/personen\/.+\/bild\?v=\d+$/);
    expect((await bild(eltern)).status).toBe(200);
    // Andere Einheiten sehen es weiterhin nicht
    expect((await bild(fremd)).status).toBe(404);
    // Nach dem Löschen der Mitteilung fällt die Freigabe weg
    await loesche(leitung, id);
    expect((await bild(eltern)).status).toBe(404);
  });
});
