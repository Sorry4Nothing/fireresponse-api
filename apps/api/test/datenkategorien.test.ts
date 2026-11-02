import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import {
  GERAET,
  KATEGORIEN,
  SPALTEN,
  type KategorieId,
} from "../src/datenkategorien.js";
import * as schema from "../src/db/schema.js";

// Tabelle -> Spalten, wie das Drizzle-Schema sie anlegt
const tabellen = Object.fromEntries(
  Object.values(schema)
    .filter((t) => t instanceof PgTable)
    .map((t) => {
      const { name, columns } = getTableConfig(t);
      return [name, columns.map((c) => c.name)];
    }),
);
const ids = Object.keys(KATEGORIEN) as KategorieId[];

describe("Datenkategorien und Schema", () => {
  test("das Schema hat Tabellen", () => {
    expect(Object.keys(tabellen).length).toBeGreaterThan(15);
  });

  test("jede Tabelle des Schemas steht in datenkategorien.ts und umgekehrt", () => {
    expect(Object.keys(SPALTEN).sort()).toEqual(Object.keys(tabellen).sort());
  });

  test.each(Object.keys(tabellen))(
    "%s: jede Spalte hat genau eine Kategorie, und keine Spalte ist erfunden",
    (tabelle) => {
      const eingetragen = Object.values(SPALTEN[tabelle] ?? {}).flat();
      expect([...eingetragen].sort()).toEqual([...tabellen[tabelle]!].sort());
    },
  );

  test("jede Kategorie in SPALTEN und GERAET gibt es", () => {
    const benutzt = [
      ...Object.values(SPALTEN).flatMap((t) => Object.keys(t)),
      ...Object.values(GERAET),
    ];
    for (const id of benutzt) expect(ids).toContain(id);
  });

  test("jede Kategorie hat Spalten oder einen Schlüssel auf dem Gerät", () => {
    const benutzt = new Set([
      ...Object.values(SPALTEN).flatMap((t) => Object.keys(t)),
      ...Object.values(GERAET),
    ]);
    expect([...benutzt].sort()).toEqual([...ids].sort());
  });
});

describe("Angaben für die Stores", () => {
  test.each(ids)("%s: apple und google sind Listen", (id) => {
    expect(Array.isArray(KATEGORIEN[id].apple)).toBe(true);
    expect(Array.isArray(KATEGORIEN[id].google)).toBe(true);
  });

  // Wer Namen oder Telefonnummern bearbeitet, nennt sie im Formular
  test.each<[KategorieId, string]>([
    ["konto", "Name"],
    ["telefon", "Phone"],
    ["teilnehmende", "Name"],
  ])("%s steht mit %s im Formular beider Stores", (id, wort) => {
    const k = KATEGORIEN[id];
    expect(k.apple.join(" ") + k.google.join(" ")).toContain(wort);
    expect(k.apple.length).toBeGreaterThan(0);
    expect(k.google.length).toBeGreaterThan(0);
  });
});
