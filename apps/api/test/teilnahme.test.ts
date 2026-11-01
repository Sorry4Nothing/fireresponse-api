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
import { kind, kindEltern, programm, teilnahme } from "../src/db/schema.js";
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
  "elternA",
  "elternB",
  "leitendeAElternB",
  "demoAdmin",
] as const;

let welt: Welt;
let konten: Record<(typeof ROLLEN)[number], PersonaKonto>;

beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  konten = Object.fromEntries(
    await Promise.all(
      ROLLEN.map(async (p) => [p, await legePersonaAn(welt, p)]),
    ),
  ) as Record<(typeof ROLLEN)[number], PersonaKonto>;
});

// Jede Anfrage schriebe sonst eine Log-Zeile in die Testausgabe
let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

const put = (
  konto: PersonaKonto,
  programmId: string,
  kindId: string,
  body: Record<string, unknown> = { status: "ja" },
) =>
  app.request(`/api/v1/programme/${programmId}/teilnahmen/${kindId}`, {
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

// Ein Programm der Stufe A, sichtbar für deren Eltern, in der Zukunft
const frisch = (extra: { beginn?: Date } = {}) =>
  legeProgrammAn(db, {
    abteilungId: welt.testabteilungId,
    sichtbarkeit: "eltern",
    stufen: [welt.stufeAId],
    ...extra,
  });

const antwort = async (programmId: string, kindId: string) => {
  const [zeile] = await db
    .select({ status: teilnahme.status, geaendertVon: teilnahme.geaendertVon })
    .from(teilnahme)
    .where(
      and(eq(teilnahme.programmId, programmId), eq(teilnahme.kindId, kindId)),
    );
  return zeile;
};

describe("PUT /api/v1/programme/:id/teilnahmen/:kindId", () => {
  test("Eltern melden ihr Kind an und ändern die Antwort", async () => {
    const p = await frisch();
    expect((await put(konten.elternA, p.id, welt.kindAId)).status).toBe(204);
    expect(await antwort(p.id, welt.kindAId)).toEqual({
      status: "ja",
      geaendertVon: konten.elternA.id,
    });
    expect(
      (await put(konten.elternA, p.id, welt.kindAId, { status: "nein" }))
        .status,
    ).toBe(204);
    expect((await antwort(p.id, welt.kindAId)).status).toBe("nein");
    // Ein Kind, eine Zeile
    const alle = await db
      .select()
      .from(teilnahme)
      .where(eq(teilnahme.programmId, p.id));
    expect(alle).toHaveLength(1);
  });

  test("Leitung der Stufe, SL und Admin korrigieren die Antwort", async () => {
    const p = await frisch();
    for (const rolle of ["leitendeA", "slA", "admin"] as const) {
      const res = await put(konten[rolle], p.id, welt.kindAId, {
        status: rolle === "admin" ? "nein" : "ja",
      });
      expect(res.status, rolle).toBe(204);
    }
    expect(await antwort(p.id, welt.kindAId)).toEqual({
      status: "nein",
      geaendertVon: konten.admin.id,
    });
  });

  test("fremde Kinder: 403, auch für Leitende und SL einer anderen Stufe", async () => {
    const p = await frisch();
    // elternA sieht das Programm, aber kindB gehört zu Stufe B und nicht zu ihr
    expect((await put(konten.elternA, p.id, welt.kindBId)).status).toBe(403);
    expect((await put(konten.slA, p.id, welt.kindBId)).status).toBe(403);
    expect((await put(konten.leitendeA, p.id, welt.kindAId)).status).toBe(204);
    expect((await put(konten.slB, p.id, welt.kindAId)).status).toBe(403);
    // Ein Kind ausserhalb der Stufen des Programms lässt sich auch dem Admin nicht zuordnen
    expect((await put(konten.admin, p.id, welt.kindBId)).status).toBe(403);
    expect(
      await db.select().from(teilnahme).where(eq(teilnahme.programmId, p.id)),
    ).toHaveLength(1);
  });

  test("Leitende A und zugleich Eltern B: nur für Stufe A zuständig, nicht für ihr Kind B", async () => {
    const p = await frisch();
    expect(
      (await put(konten.leitendeAElternB, p.id, welt.kindAId)).status,
    ).toBe(204);
    // kindB ist nicht in einer Stufe des Programms
    expect(
      (await put(konten.leitendeAElternB, p.id, welt.kindBId)).status,
    ).toBe(403);
  });

  test("unsichtbare oder unbekannte Programme und Kinder: 404", async () => {
    const p = await frisch();
    expect((await put(konten.elternB, p.id, welt.kindBId)).status).toBe(404);
    expect((await put(konten.leitendeB, p.id, welt.kindAId)).status).toBe(404);
    expect((await put(konten.demoAdmin, p.id, welt.kindAId)).status).toBe(404);
    expect((await put(konten.admin, p.id, welt.demoKindId)).status).toBe(404);
    expect((await put(konten.admin, p.id, randomUUID())).status).toBe(404);
    expect((await put(konten.admin, randomUUID(), welt.kindAId)).status).toBe(
      404,
    );
  });

  test("begonnene oder abgesagte Programme: 409", async () => {
    const begonnen = await frisch({ beginn: new Date("2020-01-01T10:00:00Z") });
    const res = await put(konten.elternA, begonnen.id, welt.kindAId);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PROGRAMM_GESCHLOSSEN");
    const abgesagt = await frisch();
    await db
      .update(programm)
      .set({ status: "abgesagt" })
      .where(eq(programm.id, abgesagt.id));
    expect((await put(konten.admin, abgesagt.id, welt.kindAId)).status).toBe(
      409,
    );
    expect(await antwort(begonnen.id, welt.kindAId)).toBeUndefined();
    expect(await antwort(abgesagt.id, welt.kindAId)).toBeUndefined();
  });

  test("inaktive Kinder: 403", async () => {
    const p = await frisch();
    const [inaktiv] = await db
      .insert(kind)
      .values({
        abteilungId: welt.testabteilungId,
        vorname: "Kind",
        nachname: "Inaktiv",
        stufeId: welt.stufeAId,
        inaktivSeit: new Date(),
      })
      .returning({ id: kind.id });
    expect((await put(konten.admin, p.id, inaktiv.id)).status).toBe(403);
  });

  test("unbekannte oder fehlende Felder und ungültige IDs: 400", async () => {
    const p = await frisch();
    const faelle: Record<string, unknown>[] = [
      {},
      { status: "offen" },
      { status: "ja", geaendertVon: konten.admin.id },
      { status: "ja", kindId: welt.kindBId },
    ];
    for (const body of faelle) {
      const res = await put(konten.elternA, p.id, welt.kindAId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await put(konten.elternA, p.id, "kein-uuid")).status).toBe(400);
    expect(await antwort(p.id, welt.kindAId)).toBeUndefined();
  });
});

describe("GET /api/v1/programme/:id mit Teilnahme", () => {
  test("Eltern sehen nur ihre Kinder der zugeordneten Stufen; ohne Antwort ist der Status null", async () => {
    const p = await frisch();
    const vorher = await detail(konten.elternA, p.id);
    expect(vorher.status).toBe(200);
    expect(vorher.body.teilnahmeOffen).toBe(true);
    expect(vorher.body.kinder).toEqual([
      { id: welt.kindAId, vorname: "Kind", status: null },
    ]);
    await put(konten.elternA, p.id, welt.kindAId, { status: "nein" });
    expect((await detail(konten.elternA, p.id)).body.kinder).toEqual([
      { id: welt.kindAId, vorname: "Kind", status: "nein" },
    ]);
    // Das Kind B steht nicht in einer Stufe des Programms
    expect((await detail(konten.leitendeAElternB, p.id)).body.kinder).toEqual(
      [],
    );
  });

  test("abgesagt oder begonnen: teilnahmeOffen ist false", async () => {
    const begonnen = await frisch({ beginn: new Date("2020-01-01T10:00:00Z") });
    expect(
      (await detail(konten.elternA, begonnen.id)).body.teilnahmeOffen,
    ).toBe(false);
  });
});

describe("GET /api/v1/programme mit Teilnahme je Kind", () => {
  const FENSTER = "von=2027-03-01&bis=2027-03-31";
  const liste = async (konto: PersonaKonto) => {
    const res = await app.request(`/api/v1/programme?${FENSTER}`, {
      headers: konto.headers,
    });
    expect(res.status).toBe(200);
    const { programme } = (await res.json()) as {
      programme: { id: string; kinder: unknown }[];
    };
    return (id: string) => programme.find((p) => p.id === id)?.kinder;
  };

  test("Eltern sehen nur eigene Kinder in zugeordneten Stufen, mit Stand", async () => {
    const a = await frisch();
    const ab = await legeProgrammAn(db, {
      abteilungId: welt.testabteilungId,
      sichtbarkeit: "eltern",
      stufen: [welt.stufeAId, welt.stufeBId],
    });
    const nurB = await legeProgrammAn(db, {
      abteilungId: welt.testabteilungId,
      sichtbarkeit: "eltern",
      stufen: [welt.stufeBId],
    });
    await put(konten.elternA, a.id, welt.kindAId, { status: "ja" });
    await put(konten.elternA, ab.id, welt.kindAId, { status: "nein" });
    const eltern = await liste(konten.elternA);
    expect(eltern(a.id)).toEqual([
      { id: welt.kindAId, vorname: "Kind", status: "ja" },
    ]);
    expect(eltern(ab.id)).toEqual([
      { id: welt.kindAId, vorname: "Kind", status: "nein" },
    ]);
    // Für elternA unsichtbar, also kein Eintrag
    expect(eltern(nurB.id)).toBeUndefined();
    // Dieselbe Person mit Kind in B: Das Kind in der nicht zugeordneten Stufe fehlt
    const gemischt = await liste(konten.leitendeAElternB);
    expect(gemischt(a.id)).toEqual([]);
    expect(gemischt(ab.id)).toEqual([
      { id: welt.kindBId, vorname: "Kind", status: null },
    ]);
    expect(gemischt(nurB.id)).toEqual([
      { id: welt.kindBId, vorname: "Kind", status: null },
    ]);
  });

  test("gleich wie im Detail; Admin und Leitende ohne eigene Kinder: leer", async () => {
    const p = await frisch();
    const detailKinder = (await detail(konten.elternA, p.id)).body.kinder;
    expect((await liste(konten.elternA))(p.id)).toEqual(detailKinder);
    for (const konto of [konten.admin, konten.slA, konten.leitendeA]) {
      expect((await liste(konto))(p.id)).toEqual([]);
    }
  });

  test("abgesagte Programme zeigen den Stand weiter; inaktive Kinder fehlen", async () => {
    const p = await frisch();
    await put(konten.elternA, p.id, welt.kindAId, { status: "ja" });
    await db
      .update(programm)
      .set({ status: "abgesagt" })
      .where(eq(programm.id, p.id));
    expect((await liste(konten.elternA))(p.id)).toEqual([
      { id: welt.kindAId, vorname: "Kind", status: "ja" },
    ]);
    const [inaktiv] = await db
      .insert(kind)
      .values({
        abteilungId: welt.testabteilungId,
        vorname: "Alt",
        nachname: "Inaktiv",
        stufeId: welt.stufeAId,
        inaktivSeit: new Date(),
      })
      .returning({ id: kind.id });
    await db
      .insert(kindEltern)
      .values({ kindId: inaktiv.id, userId: konten.elternA.id! });
    expect((await liste(konten.elternA))(p.id)).toEqual([
      { id: welt.kindAId, vorname: "Kind", status: "ja" },
    ]);
  });
});
