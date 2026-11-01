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
import { leitungAnmeldung, programm, user } from "../src/db/schema.js";
import { ladeSeiten } from "../src/seiten.js";
import { bereiteAuthTestsVor, erstelleTestAuth } from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  type PersonaKonto,
  type Welt,
} from "./hilfen/personas.js";
import { legeProgrammAn } from "./hilfen/programme.js";
import { scheitert, zurueckgerollt } from "./transaktion.js";

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

const ROLLEN = [
  "admin",
  "slA",
  "slB",
  "leitendeA",
  "leitendeB",
  "leitendeAElternB",
  "elternA",
  "elternB",
] as const;
type Rolle = (typeof ROLLEN)[number];

let welt: Welt;
let konten: Record<Rolle, PersonaKonto>;

beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  konten = Object.fromEntries(
    await Promise.all(
      ROLLEN.map(async (p) => [p, await legePersonaAn(welt, p)]),
    ),
  ) as Record<Rolle, PersonaKonto>;
});

// Die Personas dieser Datei haben alle ein Konto, id ist nie null
const idVon = (rolle: Rolle) => konten[rolle].id as string;

// Jede Anfrage schriebe sonst eine Log-Zeile in die Testausgabe
let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

const zukunft = () => new Date(Date.now() + 365 * 86_400_000);

const put = (konto: PersonaKonto, programmId: string, body: unknown) =>
  app.request(`/api/v1/programme/${programmId}/leitung`, {
    method: "PUT",
    headers: { ...konto.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const detail = async (konto: PersonaKonto, programmId: string) => {
  const res = await app.request(`/api/v1/programme/${programmId}`, {
    headers: konto.headers,
  });
  return { status: res.status, body: await res.json() };
};

const zeilen = (programmId: string) =>
  db
    .select({
      userId: leitungAnmeldung.userId,
      status: leitungAnmeldung.status,
    })
    .from(leitungAnmeldung)
    .where(eq(leitungAnmeldung.programmId, programmId));

// Beginn standardmässig in einem Jahr: Der Standard der Hilfe (März 2027) liegt irgendwann in der Vergangenheit
const frisch = (
  sichtbarkeit: "intern" | "leitende" | "eltern",
  stufen: string[],
  beginn = zukunft(),
) =>
  legeProgrammAn(db, {
    abteilungId: welt.testabteilungId,
    sichtbarkeit,
    stufen,
    beginn,
  });

describe("PUT /api/v1/programme/:id/leitung: Status je Person", () => {
  type Erwartet = Partial<Record<Rolle, number>>;
  const FAELLE: [string, "intern" | "leitende" | "eltern", Erwartet][] = [
    [
      "intern",
      "intern",
      {
        slA: 204,
        admin: 403,
        slB: 403,
        leitendeA: 404,
        leitendeAElternB: 404,
        leitendeB: 404,
        elternA: 404,
        elternB: 404,
      },
    ],
    [
      "leitende",
      "leitende",
      {
        slA: 204,
        leitendeA: 204,
        leitendeAElternB: 204,
        admin: 403,
        slB: 403,
        leitendeB: 404,
        elternA: 404,
        elternB: 404,
      },
    ],
    [
      "eltern",
      "eltern",
      {
        slA: 204,
        leitendeA: 204,
        leitendeAElternB: 204,
        admin: 403,
        slB: 403,
        elternA: 403,
        leitendeB: 404,
        elternB: 404,
      },
    ],
  ];

  test.each(FAELLE)(
    "Programm der Stufe A, %s",
    async (_name, sichtbarkeit, erwartet) => {
      const p = await frisch(sichtbarkeit, [welt.stufeAId]);
      const ergebnis: Erwartet = {};
      for (const rolle of Object.keys(erwartet) as Rolle[]) {
        ergebnis[rolle] = (
          await put(konten[rolle], p.id, { status: "ja" })
        ).status;
      }
      expect(ergebnis).toEqual(erwartet);
      // Nur wer 204 bekam, hat eine Zeile
      expect((await zeilen(p.id)).map((z) => z.userId).sort()).toEqual(
        Object.entries(erwartet)
          .filter(([, status]) => status === 204)
          .map(([rolle]) => idVon(rolle as Rolle))
          .sort(),
      );
    },
  );

  test("Programm der Stufen A und B: slB meldet sich an, der Admin nicht", async () => {
    const p = await frisch("eltern", [welt.stufeAId, welt.stufeBId]);
    expect((await put(konten.slB, p.id, { status: "ja" })).status).toBe(204);
    expect((await put(konten.slA, p.id, { status: "nein" })).status).toBe(204);
    expect((await put(konten.admin, p.id, { status: "ja" })).status).toBe(403);
  });

  test("Leitende A sieht ein Programm der Stufe B nur als Elternteil: 403", async () => {
    const p = await frisch("eltern", [welt.stufeBId]);
    const res = await put(konten.leitendeAElternB, p.id, { status: "ja" });
    expect(res.status).toBe(403);
    expect(await zeilen(p.id)).toEqual([]);
  });

  test("ein Programm ohne Stufe: 403 für alle, die es sehen", async () => {
    const p = await frisch("intern", []);
    expect((await put(konten.slA, p.id, { status: "ja" })).status).toBe(403);
    expect((await put(konten.admin, p.id, { status: "ja" })).status).toBe(403);
  });

  test("unbekannte ID: 404", async () => {
    const res = await put(konten.slA, randomUUID(), { status: "ja" });
    expect(res.status).toBe(404);
  });

  test("ein Programm einer anderen Abteilung: 404 trotz Rolle", async () => {
    const fremd = await legeProgrammAn(db, {
      abteilungId: welt.demoAbteilungId,
      sichtbarkeit: "eltern",
      beginn: zukunft(),
    });
    expect((await put(konten.slA, fremd.id, { status: "ja" })).status).toBe(
      404,
    );
    expect(await zeilen(fremd.id)).toEqual([]);
  });

  test("ja, dann nein: eine Zeile mit nein, eigeneAnmeldung folgt", async () => {
    const p = await frisch("eltern", [welt.stufeAId]);
    const eigene = async () =>
      (await detail(konten.leitendeA, p.id)).body.eigeneAnmeldung;
    expect(await eigene()).toBe("offen");
    expect((await put(konten.leitendeA, p.id, { status: "ja" })).status).toBe(
      204,
    );
    expect(await eigene()).toBe("ja");
    expect((await put(konten.leitendeA, p.id, { status: "nein" })).status).toBe(
      204,
    );
    expect(await zeilen(p.id)).toEqual([
      { userId: idVon("leitendeA"), status: "nein" },
    ]);
    expect(await eigene()).toBe("nein");
  });

  test("zwei gleichzeitige Anfragen: beide 204, eine Zeile", async () => {
    const p = await frisch("eltern", [welt.stufeAId]);
    const antworten = await Promise.all([
      put(konten.slA, p.id, { status: "ja" }),
      put(konten.slA, p.id, { status: "ja" }),
    ]);
    expect(antworten.map((a) => a.status)).toEqual([204, 204]);
    expect(await zeilen(p.id)).toHaveLength(1);
  });

  test.each([
    ["ungültiger Status", { status: "vielleicht" }],
    ["zusätzlicher Schlüssel", { status: "ja", userId: randomUUID() }],
    ["fehlender Status", {}],
  ])("%s: 400, nichts gespeichert", async (_name, body) => {
    const p = await frisch("eltern", [welt.stufeAId]);
    expect((await put(konten.slA, p.id, body)).status).toBe(400);
    expect(await zeilen(p.id)).toEqual([]);
  });
});

describe("Programmbeginn", () => {
  test("nach dem Beginn: 409 mit eigenem Code, Zeile unverändert", async () => {
    const p = await frisch("eltern", [welt.stufeAId]);
    expect((await put(konten.slA, p.id, { status: "ja" })).status).toBe(204);
    await db
      .update(programm)
      .set({ beginn: new Date(Date.now() - 60_000), ende: new Date() })
      .where(eq(programm.id, p.id));
    const res = await put(konten.slA, p.id, { status: "nein" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: "PROGRAMM_BEGONNEN",
      message: "Das Programm hat schon begonnen.",
    });
    expect(await zeilen(p.id)).toEqual([
      { userId: idVon("slA"), status: "ja" },
    ]);
  });

  test("404 und 403 gehen dem 409 vor", async () => {
    const p = await frisch(
      "eltern",
      [welt.stufeAId],
      new Date(Date.now() - 3_600_000),
    );
    expect((await put(konten.elternB, p.id, { status: "ja" })).status).toBe(
      404,
    );
    expect((await put(konten.elternA, p.id, { status: "ja" })).status).toBe(
      403,
    );
    expect((await put(konten.leitendeA, p.id, { status: "ja" })).status).toBe(
      409,
    );
  });

  test("ganztägig: heute (Schweizer Zeit) ist begonnen, morgen nicht", async () => {
    const [{ heute, morgen }] = await sql<{ heute: string; morgen: string }[]>`
      select (now() at time zone 'Europe/Zurich')::date::text as heute,
             ((now() at time zone 'Europe/Zurich')::date + 1)::text as morgen`;
    const mitTag = (tagVon: string) =>
      legeProgrammAn(db, {
        abteilungId: welt.testabteilungId,
        sichtbarkeit: "eltern",
        stufen: [welt.stufeAId],
        tagVon,
      });
    const hier = await mitTag(heute);
    expect((await put(konten.slA, hier.id, { status: "ja" })).status).toBe(409);
    const spaeter = await mitTag(morgen);
    expect((await put(konten.slA, spaeter.id, { status: "ja" })).status).toBe(
      204,
    );
  });
});

describe("eigeneAnmeldung im Programm-Detail", () => {
  test("nur bei Leitung einer Stufe des Programms, sonst fehlt der Schlüssel", async () => {
    const p = await frisch("eltern", [welt.stufeAId]);
    const ergebnis: Record<string, unknown> = {};
    for (const rolle of [
      "slA",
      "leitendeA",
      "leitendeAElternB",
      "slB",
      "admin",
      "elternA",
    ] as const) {
      const { status, body } = await detail(konten[rolle], p.id);
      expect(status).toBe(200);
      ergebnis[rolle] = "eigeneAnmeldung" in body ? body.eigeneAnmeldung : "—";
    }
    expect(ergebnis).toEqual({
      slA: "offen",
      leitendeA: "offen",
      leitendeAElternB: "offen",
      slB: "—",
      admin: "—",
      elternA: "—",
    });
  });

  test("jede Person sieht nur die eigene Anmeldung", async () => {
    const p = await frisch("eltern", [welt.stufeAId]);
    await put(konten.slA, p.id, { status: "nein" });
    expect((await detail(konten.leitendeA, p.id)).body.eigeneAnmeldung).toBe(
      "offen",
    );
    expect((await detail(konten.slA, p.id)).body.eigeneAnmeldung).toBe("nein");
  });
});

describe("Tabelle leitung_anmeldung", () => {
  test("beide Fremdschlüssel löschen mit (CASCADE)", async () => {
    const regeln = await sql`
      select confrelid::regclass::text as ziel, confdeltype from pg_constraint
      where contype = 'f' and conrelid = 'leitung_anmeldung'::regclass
      order by 1`;
    expect(regeln.map((r) => [r.ziel, r.confdeltype])).toEqual([
      ["programm", "c"],
      ['"user"', "c"],
    ]);
  });

  test("das Löschen von Programm oder Person entfernt die Zeilen", async () => {
    const p = await frisch("eltern", [welt.stufeAId]);
    const [wegwerf] = await db
      .insert(user)
      .values({
        name: "Wegwerf Person",
        email: `${randomUUID()}@example.org`,
        username: `wegwerf.${randomUUID().slice(0, 8)}`,
        abteilungId: welt.testabteilungId,
        mussPasswortAendern: false,
      })
      .returning({ id: user.id });
    await db.insert(leitungAnmeldung).values([
      { programmId: p.id, userId: wegwerf.id, status: "ja" as const },
      { programmId: p.id, userId: idVon("slA"), status: "ja" },
    ]);
    await db.delete(user).where(eq(user.id, wegwerf.id));
    expect(await zeilen(p.id)).toEqual([
      { userId: idVon("slA"), status: "ja" },
    ]);
    await db.delete(programm).where(eq(programm.id, p.id));
    expect(await zeilen(p.id)).toEqual([]);
  });

  test("die Datenbank lehnt einen anderen Status und eine doppelte Zeile ab", async () => {
    const p = await frisch("eltern", [welt.stufeAId]);
    await zurueckgerollt(sql, async (tx) => {
      await scheitert(
        tx,
        { code: "23514", constraint_name: "leitung_anmeldung_status_check" },
        (sp) =>
          sp`insert into leitung_anmeldung (programm_id, user_id, status) values (${p.id}, ${idVon("slA")}, 'offen')`,
      );
      await tx`insert into leitung_anmeldung (programm_id, user_id, status) values (${p.id}, ${idVon("slA")}, 'ja')`;
      await scheitert(
        tx,
        { code: "23505" },
        (sp) =>
          sp`insert into leitung_anmeldung (programm_id, user_id, status) values (${p.id}, ${idVon("slA")}, 'nein')`,
      );
    });
    expect(
      await db
        .select()
        .from(leitungAnmeldung)
        .where(
          and(
            eq(leitungAnmeldung.programmId, p.id),
            eq(leitungAnmeldung.userId, idVon("slA")),
          ),
        ),
    ).toEqual([]);
  });
});
