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
import { erstelleDb } from "../src/db/client.js";
import { kind, leitungAnmeldung, teilnahme, user } from "../src/db/schema.js";
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
  "leitendeAElternB",
  "elternA",
  "elternB",
  "demoAdmin",
] as const;
type Rolle = (typeof ROLLEN)[number];

let welt: Welt;
let konten: Record<Rolle, PersonaKonto>;
let kindA2: string;
let kindAInaktiv: string;
let leitendeAZwei: PersonaKonto;
let leitendeADeaktiviert: PersonaKonto;

beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  konten = Object.fromEntries(
    await Promise.all(
      ROLLEN.map(async (p) => [p, await legePersonaAn(welt, p)]),
    ),
  ) as Record<Rolle, PersonaKonto>;
  const neuesKind = async (vorname: string, inaktiv = false) => {
    const [zeile] = await db
      .insert(kind)
      .values({
        abteilungId: welt.testabteilungId,
        vorname,
        nachname: "A",
        stufeId: welt.stufeAId,
        inaktivSeit: inaktiv ? new Date() : null,
      })
      .returning({ id: kind.id });
    return zeile.id;
  };
  // «Kind» (kindA) sortiert vor «Zweit»; das inaktive Kind darf nie erscheinen
  kindA2 = await neuesKind("Zweit");
  kindAInaktiv = await neuesKind("Inaktiv", true);
  leitendeAZwei = await legePersonaAn(welt, "leitendeA");
  leitendeADeaktiviert = await legePersonaAn(welt, "leitendeA");
  await db
    .update(user)
    .set({ deaktiviertAm: new Date() })
    .where(eq(user.id, leitendeADeaktiviert.id as string));
});

const idVon = (konto: PersonaKonto) => konto.id as string;

// Jede Anfrage schriebe sonst eine Log-Zeile in die Testausgabe
let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

const zukunft = () => new Date(Date.now() + 365 * 86_400_000);

const frisch = (
  stufen: string[],
  sichtbarkeit: "intern" | "eltern" = "eltern",
) =>
  legeProgrammAn(db, {
    abteilungId: welt.testabteilungId,
    sichtbarkeit,
    stufen,
    beginn: zukunft(),
  });

const uebersicht = async (konto: PersonaKonto, programmId: string) => {
  const res = await app.request(`/api/v1/programme/${programmId}/teilnahmen`, {
    headers: konto.headers,
  });
  return { status: res.status, body: await res.json() };
};

const antworten = (programmId: string, liste: [string, "ja" | "nein"][]) =>
  db
    .insert(teilnahme)
    .values(liste.map(([kindId, status]) => ({ programmId, kindId, status })));

describe("GET /api/v1/programme/:id/teilnahmen: Status je Person", () => {
  const ERWARTET: Record<Rolle, number> = {
    admin: 200,
    slA: 200,
    leitendeA: 200,
    leitendeAElternB: 200,
    elternA: 200,
    // slB sieht jedes Programm der Abteilung, ist aber weder Leitung von A noch Elternteil
    slB: 403,
    leitendeB: 404,
    elternB: 404,
    demoAdmin: 404,
  };
  test.each(Object.entries(ERWARTET))("%s: %i", async (rolle, status) => {
    const p = await frisch([welt.stufeAId]);
    expect((await uebersicht(konten[rolle as Rolle], p.id)).status).toBe(
      status,
    );
  });

  test("intern: nur Admin und SL sehen es, SL einer fremden Stufe hat kein Recht", async () => {
    const p = await frisch([welt.stufeAId], "intern");
    const status = async (r: Rolle) =>
      (await uebersicht(konten[r], p.id)).status;
    expect(await status("admin")).toBe(200);
    expect(await status("slA")).toBe(200);
    expect(await status("slB")).toBe(403);
    expect(await status("leitendeA")).toBe(404);
    expect(await status("elternA")).toBe(404);
  });

  test("unbekanntes Programm: 404; keine UUID: 400", async () => {
    const res = await uebersicht(
      konten.admin,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(res.status).toBe(404);
    expect((await uebersicht(konten.admin, "keine-uuid")).status).toBe(400);
  });
});

describe("GET /api/v1/programme/:id/teilnahmen: Inhalt", () => {
  test("Leitung sieht Zahlen, alle aktiven Kinder und die Leitenden der Stufe", async () => {
    const p = await frisch([welt.stufeAId]);
    await antworten(p.id, [
      [welt.kindAId, "ja"],
      [kindAInaktiv, "ja"],
    ]);
    await db.insert(leitungAnmeldung).values([
      { programmId: p.id, userId: idVon(konten.slA), status: "ja" },
      {
        programmId: p.id,
        userId: idVon(konten.leitendeAElternB),
        status: "nein",
      },
    ]);
    const { status, body } = await uebersicht(konten.leitendeA, p.id);
    expect(status).toBe(200);
    // kindA ja, Zweit offen; das inaktive Kind fehlt trotz Antwort
    expect(body.kinder).toEqual([
      {
        id: welt.kindAId,
        vorname: "Kind",
        nachname: "A",
        stufeId: welt.stufeAId,
        status: "ja",
      },
      {
        id: kindA2,
        vorname: "Zweit",
        nachname: "A",
        stufeId: welt.stufeAId,
        status: "offen",
      },
    ]);
    expect(body.zahlen.kinder).toEqual({ ja: 1, nein: 0, offen: 1 });
    // Das deaktivierte Konto und die Leitenden anderer Stufen fehlen
    const ids = body.leitende.map((l: { id: string }) => l.id).sort();
    expect(ids).toEqual(
      [
        idVon(konten.slA),
        idVon(konten.leitendeA),
        idVon(leitendeAZwei),
        idVon(konten.leitendeAElternB),
      ].sort(),
    );
    const nach = (konto: PersonaKonto) =>
      body.leitende.find((l: { id: string }) => l.id === konto.id);
    expect(nach(konten.slA)).toMatchObject({
      status: "ja",
      rolle: "stufenleitung",
    });
    expect(nach(konten.leitendeAElternB)).toMatchObject({
      status: "nein",
      rolle: "leitung",
    });
    expect(nach(konten.leitendeA)).toMatchObject({
      status: "offen",
      rolle: "leitung",
    });
    expect(body.zahlen.leitende).toEqual({ ja: 1, nein: 1, offen: 2 });
  });

  test("eine Antwort der Eltern zählt sofort in der Übersicht", async () => {
    const p = await frisch([welt.stufeAId]);
    const put = await app.request(
      `/api/v1/programme/${p.id}/teilnahmen/${welt.kindAId}`,
      {
        method: "PUT",
        headers: {
          ...konten.elternA.headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "nein" }),
      },
    );
    expect(put.status).toBe(204);
    const { body } = await uebersicht(konten.slA, p.id);
    expect(body.zahlen.kinder).toEqual({ ja: 0, nein: 1, offen: 1 });
  });

  test("Eltern sehen nur ihr eigenes Kind, ohne Leitende", async () => {
    const p = await frisch([welt.stufeAId]);
    await antworten(p.id, [
      [welt.kindAId, "ja"],
      [kindA2, "nein"],
    ]);
    const { status, body } = await uebersicht(konten.elternA, p.id);
    expect(status).toBe(200);
    expect(body.kinder).toHaveLength(1);
    expect(body.kinder[0]).toMatchObject({ id: welt.kindAId, status: "ja" });
    expect(body.leitende).toEqual([]);
    expect(body.zahlen).toEqual({
      kinder: { ja: 1, nein: 0, offen: 0 },
      leitende: { ja: 0, nein: 0, offen: 0 },
    });
    expect(JSON.stringify(body)).not.toContain(kindA2);
  });

  test("Abteilungsanlass: Leitung sieht nur die eigene Stufe, Admin beide, Doppelrolle beides getrennt", async () => {
    const p = await frisch([welt.stufeAId, welt.stufeBId]);
    const stufenVon = (b: { kinder: { stufeId: string }[] }) => [
      ...new Set(b.kinder.map((k) => k.stufeId)),
    ];
    const leitendeA = (await uebersicht(konten.leitendeA, p.id)).body;
    expect(stufenVon(leitendeA)).toEqual([welt.stufeAId]);
    expect(leitendeA.kinder.map((k: { id: string }) => k.id)).not.toContain(
      welt.kindBId,
    );
    const admin = (await uebersicht(konten.admin, p.id)).body;
    expect(stufenVon(admin).sort()).toEqual(
      [welt.stufeAId, welt.stufeBId].sort(),
    );
    // Leitung von A und Elternteil von Kind B: ganze Stufe A plus nur das eigene Kind aus B
    const doppel = (await uebersicht(konten.leitendeAElternB, p.id)).body;
    expect(doppel.kinder.map((k: { id: string }) => k.id).sort()).toEqual(
      [welt.kindAId, kindA2, welt.kindBId].sort(),
    );
    expect(
      doppel.leitende.every(
        (l: { stufeId: string }) => l.stufeId === welt.stufeAId,
      ),
    ).toBe(true);
  });

  test("Admin: ein Programm ohne Stufe liefert leere Listen", async () => {
    const p = await frisch([], "intern");
    const { status, body } = await uebersicht(konten.admin, p.id);
    expect(status).toBe(200);
    expect(body.kinder).toEqual([]);
    expect(body.leitende).toEqual([]);
  });

  test("ein Kind, das die Stufe wechselt, verschwindet aus der alten Übersicht", async () => {
    const p = await frisch([welt.stufeAId]);
    await antworten(p.id, [[kindA2, "ja"]]);
    await db
      .update(kind)
      .set({ stufeId: welt.stufeBId })
      .where(eq(kind.id, kindA2));
    try {
      const { body } = await uebersicht(konten.slA, p.id);
      expect(body.kinder.map((k: { id: string }) => k.id)).toEqual([
        welt.kindAId,
      ]);
    } finally {
      await db
        .update(kind)
        .set({ stufeId: welt.stufeAId })
        .where(eq(kind.id, kindA2));
    }
  });
});
