import { sql } from "drizzle-orm";
import { rang } from "./db/schema.js";

// Felder für den Select; setzt einen leftJoin auf rang voraus. Die Apps bekommen nur das Abzeichen, nie Name, Kürzel oder Reihenfolge des Rangs
export const abzeichenFelder = {
  rangId: rang.id,
  sterne: rang.abzeichenSterne,
  hatBild: sql<boolean>`${rang.abzeichenBild} is not null`,
};

// Entweder Sterne (0 bis 5) oder die URL eines eigenen Bildes; null ohne Rang oder ohne Abzeichen
export function abzeichen(zeile: {
  rangId: string | null;
  sterne: number | null;
  hatBild: boolean | null;
}) {
  if (zeile.rangId === null) return null;
  if (zeile.hatBild) {
    return {
      sterne: null,
      bildUrl: `/api/v1/raenge/${zeile.rangId}/abzeichen`,
    };
  }
  return zeile.sterne === null ? null : { sterne: zeile.sterne, bildUrl: null };
}
