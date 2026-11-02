import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
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
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { legeEinheitAn, MILIZ_RAENGE } from "../src/einheiten.js";
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

// Eine Welt pro Test: Kommandant und Positionen der Stellvertretung gibt es je Einheit nur einmal
let welt: Welt;
beforeEach(async () => {
  welt = await erstelleWelt(db, auth);
});

const person = (persona: Persona) => legePersonaAn(welt, persona);

const uebergeben = (konto: PersonaKonto, einheitId: string, body: unknown) =>
  app.request(`/api/v1/admin/einheiten/${einheitId}/kommando`, {
    method: "POST",
    headers: { ...konto.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const rollen = async (einheitId: string) =>
  db
    .select({
      userId: schema.einheitRolle.userId,
      typ: schema.einheitRolle.typ,
      reihenfolge: schema.einheitRolle.reihenfolge,
    })
    .from(schema.einheitRolle)
    .where(eq(schema.einheitRolle.einheitId, einheitId))
    .orderBy(
      asc(schema.einheitRolle.reihenfolge),
      asc(schema.einheitRolle.typ),
    );

describe("POST /api/v1/admin/einheiten/:id/kommando", () => {
  test("Kantonsadmin übergibt: die bisherige Person wird Stellvertretung an der gewünschten Position, die übrigen rücken nach", async () => {
    const [admin, alt, stv1, stv2, leitung] = await Promise.all([
      person("kantonsadmin"),
      person("kommandoJfA"),
      person("stellvertretung1JfA"),
      person("stellvertretung2JfA"),
      person("leitendeJfA"),
    ]);

    const antwort = await uebergeben(admin, welt.einheit.jfA, {
      neuerKommandantId: leitung.id,
      bisherigeRolle: { typ: "stellvertretung", reihenfolge: 1 },
    });

    expect(antwort.status).toBe(204);
    const jetzt = await rollen(welt.einheit.jfA);
    expect(jetzt).toEqual(
      expect.arrayContaining([
        { userId: leitung.id, typ: "kommandant", reihenfolge: null },
        { userId: alt.id, typ: "stellvertretung", reihenfolge: 1 },
        { userId: stv1.id, typ: "stellvertretung", reihenfolge: 2 },
        { userId: stv2.id, typ: "stellvertretung", reihenfolge: 3 },
      ]),
    );
    expect(jetzt.filter((r) => r.typ === "kommandant")).toHaveLength(1);
    // Das Protokoll nennt die Aktion, nie einen Namen
    const [eintrag] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.zielId, welt.einheit.jfA));
    expect(eintrag).toMatchObject({
      einheitId: welt.einheit.jfA,
      akteurId: admin.id,
      aktion: "kommando_uebergeben",
      details: { bisherigeRolle: "stellvertretung" },
    });
  });

  test("bisherige Rolle Leitung oder keine; der Rang wandert mit der Person", async () => {
    const [admin, alt, neu] = await Promise.all([
      person("kantonsadmin"),
      person("kommandoJfA"),
      person("leitendeJfA"),
    ]);
    await db
      .update(schema.einheitRolle)
      .set({ rangId: welt.rangId })
      .where(eq(schema.einheitRolle.userId, alt.id!));

    expect(
      (
        await uebergeben(admin, welt.einheit.jfA, {
          neuerKommandantId: neu.id,
          bisherigeRolle: { typ: "leitung" },
        })
      ).status,
    ).toBe(204);
    expect(await rollen(welt.einheit.jfA)).toEqual(
      expect.arrayContaining([
        { userId: neu.id, typ: "kommandant", reihenfolge: null },
        { userId: alt.id, typ: "leitung", reihenfolge: null },
      ]),
    );
    const [mitRang] = await db
      .select({ rangId: schema.einheitRolle.rangId })
      .from(schema.einheitRolle)
      .where(eq(schema.einheitRolle.userId, alt.id!));
    expect(mitRang.rangId).toBe(welt.rangId);

    // Zurück, und diesmal ohne Rolle für die bisherige Person
    expect(
      (
        await uebergeben(admin, welt.einheit.jfA, {
          neuerKommandantId: alt.id,
          bisherigeRolle: { typ: "keine" },
        })
      ).status,
    ).toBe(204);
    const ohne = await rollen(welt.einheit.jfA);
    expect(ohne.find((r) => r.userId === neu.id)).toBeUndefined();
    expect(ohne.filter((r) => r.typ === "kommandant")).toEqual([
      { userId: alt.id, typ: "kommandant", reihenfolge: null },
    ]);
  });

  test("die neue Person darf noch keine Rolle in der Einheit haben, eine Stellvertretung wird Kommandant und gibt ihre Position frei", async () => {
    const [admin, alt, stv] = await Promise.all([
      person("kantonsadmin"),
      person("kommandoJfA"),
      person("stellvertretung1JfA"),
    ]);
    expect(
      (
        await uebergeben(admin, welt.einheit.jfA, {
          neuerKommandantId: stv.id,
          bisherigeRolle: { typ: "stellvertretung", reihenfolge: 1 },
        })
      ).status,
    ).toBe(204);
    expect(await rollen(welt.einheit.jfA)).toEqual(
      expect.arrayContaining([
        { userId: stv.id, typ: "kommandant", reihenfolge: null },
        { userId: alt.id, typ: "stellvertretung", reihenfolge: 1 },
      ]),
    );
  });

  test.each([
    ["kommandoJfA", "jfA", 403],
    ["stellvertretung1JfA", "jfA", 403],
    ["leitendeJfA", "jfA", 403],
    ["elternJfA", "jfA", 403],
    // Fremde Einheiten sind unsichtbar: 404 geht dem 403 vor
    ["kommandoKfA", "jfA", 404],
    ["kommandoJfB", "jfA", 404],
    ["elternKfA", "jfA", 404],
  ] as const)(
    "%s auf %s: %i, die Rollen bleiben",
    async (persona, einheit, status) => {
      const [konto, ziel] = await Promise.all([
        person(persona),
        person("leitendeJfA"),
      ]);
      // Die Einheit hat ein Kommando: die Persona selbst oder eine zweite Person
      if (persona !== "kommandoJfA") await person("kommandoJfA");
      const vorher = await rollen(welt.einheit[einheit]);
      const antwort = await uebergeben(konto, welt.einheit[einheit], {
        neuerKommandantId: ziel.id,
        bisherigeRolle: { typ: "keine" },
      });
      // 403 aus der Rolle (Kommando ohne zweiten Faktor wird schon von der Sperre abgefangen): beides ist kein 204
      expect(antwort.status).toBe(status);
      expect(await rollen(welt.einheit[einheit])).toEqual(vorher);
    },
  );

  test("Kantonsadmin ohne zweiten Faktor: 403 ZWEITER_FAKTOR_FEHLT", async () => {
    const [konto, ziel] = await Promise.all([
      person("kantonsadminOhneZweitenFaktor"),
      person("leitendeJfA"),
    ]);
    await person("kommandoJfA");
    const antwort = await uebergeben(konto, welt.einheit.jfA, {
      neuerKommandantId: ziel.id,
      bisherigeRolle: { typ: "keine" },
    });
    expect(antwort.status).toBe(403);
    expect(await antwort.json()).toMatchObject({
      code: "ZWEITER_FAKTOR_FEHLT",
    });
  });

  test("unbekannte, deaktivierte oder Kantonsadmin-Ziele: 400, nichts ändert sich", async () => {
    const [admin, alt, anderer, deaktiviert] = await Promise.all([
      person("kantonsadmin"),
      person("kommandoJfA"),
      person("kantonsadminOhneZweitenFaktor"),
      person("elternJfA"),
    ]);
    await db
      .update(schema.user)
      .set({ deaktiviertAm: new Date() })
      .where(eq(schema.user.id, deaktiviert.id!));
    const vorher = await rollen(welt.einheit.jfA);
    for (const neuerKommandantId of [
      randomUUID(),
      anderer.id,
      deaktiviert.id,
    ]) {
      const antwort = await uebergeben(admin, welt.einheit.jfA, {
        neuerKommandantId,
        bisherigeRolle: { typ: "keine" },
      });
      expect(antwort.status).toBe(400);
    }
    expect(await rollen(welt.einheit.jfA)).toEqual(vorher);
    expect(vorher.find((r) => r.userId === alt.id)?.typ).toBe("kommandant");
  });

  test("dieselbe Person: 409 GLEICHE_PERSON; ungültige Körper: 400; unbekannte Einheit: 404", async () => {
    const [admin, alt] = await Promise.all([
      person("kantonsadmin"),
      person("kommandoJfA"),
    ]);
    const gleich = await uebergeben(admin, welt.einheit.jfA, {
      neuerKommandantId: alt.id,
      bisherigeRolle: { typ: "keine" },
    });
    expect(gleich.status).toBe(409);
    expect(await gleich.json()).toMatchObject({ code: "GLEICHE_PERSON" });
    for (const body of [
      {},
      { neuerKommandantId: alt.id },
      { neuerKommandantId: "x", bisherigeRolle: { typ: "keine" } },
      {
        neuerKommandantId: randomUUID(),
        bisherigeRolle: { typ: "stellvertretung" },
      },
      {
        neuerKommandantId: randomUUID(),
        bisherigeRolle: { typ: "stellvertretung", reihenfolge: 0 },
      },
      {
        neuerKommandantId: randomUUID(),
        bisherigeRolle: { typ: "keine" },
        einheitId: randomUUID(),
      },
    ]) {
      expect((await uebergeben(admin, welt.einheit.jfA, body)).status).toBe(
        400,
      );
    }
    expect(
      (
        await uebergeben(admin, randomUUID(), {
          neuerKommandantId: alt.id,
          bisherigeRolle: { typ: "keine" },
        })
      ).status,
    ).toBe(404);
  });
});

describe("legeEinheitAn", () => {
  test("legt die Einheit zusammen mit der Kommandantin oder dem Kommandanten an", async () => {
    const [admin, kommandant] = await Promise.all([
      person("kantonsadmin"),
      person("elternJfA"),
    ]);
    const [bezirk] = await db
      .insert(schema.bezirk)
      .values({ name: `Neu ${randomUUID()}` })
      .returning();
    const id = await db.transaction((tx) =>
      legeEinheitAn(tx, {
        bezirkId: bezirk.id,
        typ: "jf",
        name: "Neue JF",
        kommandantId: kommandant.id!,
        akteurId: admin.id!,
      }),
    );
    expect(await rollen(id)).toEqual([
      { userId: kommandant.id, typ: "kommandant", reihenfolge: null },
    ]);
  });

  test("legt die vier Standard-Ränge und die Miliz-Dienstgrade an", async () => {
    const [admin, kommandant] = await Promise.all([
      person("kantonsadmin"),
      person("elternJfA"),
    ]);
    const [bezirk] = await db
      .insert(schema.bezirk)
      .values({ name: `Raenge ${randomUUID()}` })
      .returning();
    const id = await db.transaction((tx) =>
      legeEinheitAn(tx, {
        bezirkId: bezirk.id,
        typ: "kf",
        name: "Neue KF",
        kommandantId: kommandant.id!,
        akteurId: admin.id!,
      }),
    );
    const raenge = await db
      .select({
        name: schema.rang.name,
        typ: schema.rang.typ,
        reihenfolge: schema.rang.reihenfolge,
        sterne: schema.rang.abzeichenSterne,
      })
      .from(schema.rang)
      .where(eq(schema.rang.einheitId, id))
      .orderBy(schema.rang.typ, schema.rang.reihenfolge);
    expect(raenge.slice(0, 4)).toEqual(
      [null, 0, 1, 2].map((sterne, n) => ({
        name: `Rang ${n}`,
        typ: "kf",
        reihenfolge: (n + 1) * 10,
        sterne,
      })),
    );
    expect(raenge.slice(4).map((r) => [r.name, r.typ, r.reihenfolge])).toEqual(
      MILIZ_RAENGE.map((r, n) => [r.name, "miliz", (n + 1) * 10]),
    );
    expect(raenge).toHaveLength(18);
  });

  test("scheitert die Kommandantin oder der Kommandant, entsteht keine Einheit", async () => {
    const admin = await person("kantonsadmin");
    const [bezirk] = await db
      .insert(schema.bezirk)
      .values({ name: `Leer ${randomUUID()}` })
      .returning();
    await expect(
      db.transaction((tx) =>
        legeEinheitAn(tx, {
          bezirkId: bezirk.id,
          typ: "kf",
          name: "Ohne Kommando",
          kommandantId: randomUUID(),
          akteurId: admin.id!,
        }),
      ),
    ).rejects.toBeDefined();
    expect(
      await db
        .select()
        .from(schema.einheit)
        .where(eq(schema.einheit.bezirkId, bezirk.id)),
    ).toEqual([]);
  });
});
