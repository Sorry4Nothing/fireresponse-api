import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, expect, test, vi } from "vitest";
import { API_URL } from "./hilfen/datenbank.js";

const sql = postgres(API_URL);
afterAll(() => sql.end());

// Die Migration 0007 läuft auf temporären Tabellen derselben Verbindung, damit sie die echte Tabelle der übrigen Tests nicht anfasst
test("0007 gibt bestehenden Rängen den Typ ihrer Einheit und sperrt andere Typen", async () => {
  const migration = readFileSync(
    new URL("../drizzle/0007_rang_typ.sql", import.meta.url),
    "utf8",
  );
  const verbindung = await sql.reserve();
  try {
    await verbindung`create temp table einheit (id uuid primary key, typ text not null)`;
    await verbindung`create temp table rang (id uuid primary key default gen_random_uuid(), einheit_id uuid not null, name text not null)`;
    await verbindung`insert into einheit (id, typ) values ('00000000-0000-0000-0000-00000000000a', 'kf'), ('00000000-0000-0000-0000-00000000000b', 'jf')`;
    await verbindung`insert into rang (einheit_id, name) values ('00000000-0000-0000-0000-00000000000a', 'kinder'), ('00000000-0000-0000-0000-00000000000b', 'jugend')`;
    for (const teil of migration.split("--> statement-breakpoint")) {
      await verbindung.unsafe(teil);
    }
    const zeilen = await verbindung<
      { name: string; typ: string }[]
    >`select name, typ from rang order by name`;
    expect(zeilen.map((z) => [z.name, z.typ])).toEqual([
      ["jugend", "jf"],
      ["kinder", "kf"],
    ]);
    await expect(
      verbindung`update rang set typ = 'miliz' where name = 'kinder'`,
    ).resolves.toBeDefined();
    await expect(
      verbindung`update rang set typ = 'feuerwehr' where name = 'kinder'`,
    ).rejects.toMatchObject({ constraint_name: "rang_typ_check" });
  } finally {
    verbindung.release();
  }
});

test("die Verwaltung kennt die drei Rangtypen", async () => {
  // dom.js hängt beim Laden einen Klick-Handler an die Seite; hier genügt eine Attrappe
  vi.stubGlobal("document", { addEventListener: () => {} });
  const { RANGTYP } = await import(
    new URL("../public/admin/raenge.js", import.meta.url).href
  );
  expect(Object.keys(RANGTYP)).toEqual(["kf", "jf", "miliz"]);
});
