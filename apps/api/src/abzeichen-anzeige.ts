import { sql } from "drizzle-orm";
import { rang } from "./db/schema.js";

// Felder für den Select; setzt einen leftJoin auf rang voraus. Die Apps bekommen nur das Abzeichen (Kürzel, Sterne oder Bild), nie Name oder Reihenfolge des Rangs
export const abzeichenFelder = {
  rangId: rang.id,
  kuerzel: rang.kuerzel,
  sterne: rang.abzeichenSterne,
  hatBild: sql<boolean>`${rang.abzeichenBild} is not null`,
};

type AbzeichenZeile = {
  rangId: string | null;
  kuerzel: string | null;
  sterne: number | null;
  hatBild: boolean | null;
};

// Für jede Person mit Rang ein Objekt: das Kürzel, dazu Sterne (0 bis 5) oder die URL eines eigenen Bildes; sind beide null, hat der Rang nur das Kürzel. null heisst: kein Rang
export function abzeichen(zeile: AbzeichenZeile) {
  if (zeile.rangId === null || zeile.kuerzel === null) return null;
  if (zeile.hatBild) {
    return {
      kuerzel: zeile.kuerzel,
      sterne: null,
      bildUrl: `/api/v1/raenge/${zeile.rangId}/abzeichen`,
    };
  }
  return { kuerzel: zeile.kuerzel, sterne: zeile.sterne, bildUrl: null };
}

// Ersetzt die Rang-Hilfsfelder einer Zeile durch das fertige Abzeichen
export function mitAbzeichen<T extends AbzeichenZeile>(zeile: T) {
  const { rangId, kuerzel, sterne, hatBild, ...rest } = zeile;
  return {
    ...rest,
    abzeichen: abzeichen({ rangId, kuerzel, sterne, hatBild }),
  };
}
