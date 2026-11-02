import { inArray, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { rang } from "./db/schema.js";

// Felder für den Select aus rang; die Verwaltung baut daraus das Abzeichen (Sterne oder Bild)
const rangFelder = {
  id: rang.id,
  name: rang.name,
  kuerzel: rang.kuerzel,
  einheitId: rang.einheitId,
  sterne: rang.abzeichenSterne,
  bildTyp: rang.abzeichenBildTyp,
  // Ändert sich mit dem Bild: Die Verwaltung hängt es an die Adresse
  bildStand: sql<string | null>`left(md5(${rang.abzeichenBild}), 8)`,
};

type RangZeile = {
  id: string;
  einheitId: string;
  sterne: number | null;
  bildTyp: string | null;
  bildStand: string | null;
};

// Abzeichen in der Form der Verwaltung: Bild über seine Adresse, Sterne oder keines
export function adminAbzeichen(r: RangZeile) {
  if (r.bildTyp !== null) {
    return {
      art: "bild" as const,
      typ: r.bildTyp,
      url: `/api/v1/admin/einheiten/${r.einheitId}/raenge/${r.id}/abzeichen?v=${r.bildStand}`,
    };
  }
  return r.sterne !== null
    ? { art: "sterne" as const, sterne: r.sterne }
    : null;
}

// Rang mit Name, Kürzel und Abzeichen für Listen der Verwaltung
export function adminRang(r: RangZeile & { name: string; kuerzel: string }) {
  return {
    id: r.id,
    name: r.name,
    kuerzel: r.kuerzel,
    abzeichen: adminAbzeichen(r),
  };
}

// Ein Abruf für alle Ränge einer Liste; ohne Rang (null) kein Eintrag
export async function ladeAdminRaenge(db: Db, ids: (string | null)[]) {
  const eindeutig = [...new Set(ids.filter((id) => id !== null))];
  if (eindeutig.length === 0) return new Map<string, AdminRang>();
  const zeilen = await db
    .select(rangFelder)
    .from(rang)
    .where(inArray(rang.id, eindeutig));
  return new Map(zeilen.map((z) => [z.id, adminRang(z)]));
}

export type AdminRang = ReturnType<typeof adminRang>;
