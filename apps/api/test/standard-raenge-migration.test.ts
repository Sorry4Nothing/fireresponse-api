import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, expect, test } from "vitest";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { API_URL } from "./hilfen/datenbank.js";

const sql = postgres(API_URL);
const db = erstelleDb(sql);
afterAll(() => sql.end());

// Die Migration 0005 stellt nur unveränderte Standard-Ränge der Migration 0004 um
test("0005 stellt unveränderte Standard-Ränge auf vier um und lässt geänderte stehen", async () => {
  const migration = readFileSync(
    new URL("../drizzle/0005_standard_raenge_vier.sql", import.meta.url),
    "utf8",
  );
  const einheit = async (
    typ: "jf" | "kf",
    sterne: (n: number) => number,
  ): Promise<string> => {
    const [b] = await db
      .insert(schema.bezirk)
      .values({ name: `Migration ${randomUUID()}` })
      .returning();
    const [e] = await db
      .insert(schema.einheit)
      .values({ bezirkId: b.id, typ, name: "Migration" })
      .returning();
    await db.insert(schema.rang).values(
      [0, 1, 2, 3, 4, 5].map((n) => ({
        einheitId: e.id,
        name: `Rang ${n}`,
        kuerzel: `R${n}`,
        reihenfolge: (n + 1) * 10,
        abzeichenSterne: sterne(n),
      })),
    );
    return e.id;
  };
  const unveraendert = await einheit("jf", (n) => n);
  const geaendert = await einheit("kf", (n) => (n === 1 ? 4 : n));
  for (const teil of migration.split("--> statement-breakpoint")) {
    await sql.unsafe(teil);
  }
  const lies = async (id: string) =>
    (
      await db
        .select({
          name: schema.rang.name,
          sterne: schema.rang.abzeichenSterne,
        })
        .from(schema.rang)
        .where(eq(schema.rang.einheitId, id))
        .orderBy(asc(schema.rang.reihenfolge))
    ).map((r) => [r.name, r.sterne]);
  expect(await lies(unveraendert)).toEqual([
    ["Rang 0", null],
    ["Rang 1", 0],
    ["Rang 2", 1],
    ["Rang 3", 2],
  ]);
  // Rang 1 hat einen eigenen Stand (4 Sterne): bleibt, die übrigen werden umgestellt
  expect(await lies(geaendert)).toEqual([
    ["Rang 0", null],
    ["Rang 1", 4],
    ["Rang 2", 1],
    ["Rang 3", 2],
  ]);
});
