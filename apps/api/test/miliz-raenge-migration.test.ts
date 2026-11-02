import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, expect, test } from "vitest";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { pruefeAbzeichen } from "../src/abzeichen.js";
import { MILIZ_RAENGE } from "../src/einheiten.js";
import { API_URL } from "./hilfen/datenbank.js";

const sql = postgres(API_URL);
const db = erstelleDb(sql);
afterAll(() => sql.end());

test("0008 legt die Miliz-Dienstgrade mit eigener Reihenfolge an und lässt Einheiten mit Miliz-Rang stehen", async () => {
  const migration = readFileSync(
    new URL("../drizzle/0008_miliz_raenge.sql", import.meta.url),
    "utf8",
  );
  const einheit = async (
    raenge: { name: string; typ: "jf" | "miliz"; reihenfolge: number }[],
  ) => {
    const [b] = await db
      .insert(schema.bezirk)
      .values({ name: `Migration ${randomUUID()}` })
      .returning();
    const [e] = await db
      .insert(schema.einheit)
      .values({ bezirkId: b.id, typ: "jf", name: "Migration" })
      .returning();
    await db
      .insert(schema.rang)
      .values(raenge.map((r) => ({ ...r, kuerzel: r.name, einheitId: e.id })));
    return e.id;
  };
  const ohne = await einheit([
    { name: "Rang 0", typ: "jf", reihenfolge: 10 },
    { name: "Rang 1", typ: "jf", reihenfolge: 40 },
  ]);
  const mit = await einheit([
    { name: "Eigener Grad", typ: "miliz", reihenfolge: 10 },
  ]);
  const voll = await einheit([{ name: "Rang 0", typ: "jf", reihenfolge: 900 }]);
  // Nur das Einfügen: Die API-Rolle ändert nichts am Schema, und die Testdatenbank hat die Änderung des Index schon
  await sql.unsafe(migration.split("--> statement-breakpoint").at(-1)!);
  const lies = async (id: string) =>
    (
      await db
        .select({
          name: schema.rang.name,
          typ: schema.rang.typ,
          reihenfolge: schema.rang.reihenfolge,
        })
        .from(schema.rang)
        .where(eq(schema.rang.einheitId, id))
        .orderBy(asc(schema.rang.typ), asc(schema.rang.reihenfolge))
    ).map((r) => [r.name, r.typ, r.reihenfolge]);
  // Die Reihenfolge zählt je Typ: Miliz-Ränge beginnen bei 10, auch wenn der Typ jf bis 900 reicht
  const miliz = MILIZ_RAENGE.map((r, n) => [r.name, "miliz", (n + 1) * 10]);
  expect(await lies(ohne)).toEqual([
    ["Rang 0", "jf", 10],
    ["Rang 1", "jf", 40],
    ...miliz,
  ]);
  expect(await lies(mit)).toEqual([["Eigener Grad", "miliz", 10]]);
  expect(await lies(voll)).toEqual([["Rang 0", "jf", 900], ...miliz]);
  // Die Abzeichen der Migration sind dieselben wie beim Anlegen einer Einheit und bestehen die Prüfung der Bilder
  const bilder = await db
    .select({
      name: schema.rang.name,
      bild: schema.rang.abzeichenBild,
      typ: schema.rang.abzeichenBildTyp,
    })
    .from(schema.rang)
    .where(eq(schema.rang.einheitId, ohne));
  for (const r of MILIZ_RAENGE) {
    const z = bilder.find((b) => b.name === r.name)!;
    expect(z.typ).toBe("svg");
    expect(Buffer.from(z.bild!).equals(Buffer.from(r.abzeichenBild))).toBe(
      true,
    );
    expect(() => pruefeAbzeichen(r.abzeichenBild)).not.toThrow();
  }
});
