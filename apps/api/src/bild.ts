import { sql } from "drizzle-orm";
import { profilbild } from "./db/schema.js";

// Hart, vor dem Einlesen: Das Bild wird danach ohnehin auf rund 20 KB verkleinert, das Original ist nur der Weg dorthin
export const BILD_MAX_BYTES = 5 * 1024 * 1024;

// Kodiert ein Foto neu (Grösse, Format, ohne Metadaten) oder wirft, wenn es kein lesbares Bild ist; die Umsetzung mit sharp steht in bild-sharp.ts, damit die App ohne die Typen von Node prüft
export type BildKodierer = (daten: Uint8Array) => Promise<Uint8Array>;

// Dateityp aus den ersten Bytes, nie aus Dateiendung oder Content-Type: JPEG, PNG und WebP; alles andere (SVG, GIF, HEIC, PDF) lehnt die Route ab
export function istErlaubtesBild(b: Uint8Array) {
  const ist = (ab: number, bytes: number[]) =>
    bytes.every((byte, i) => b[ab + i] === byte);
  return (
    ist(0, [0xff, 0xd8, 0xff]) ||
    ist(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    // «RIFF», vier Bytes Länge, «WEBP»
    (ist(0, [0x52, 0x49, 0x46, 0x46]) && ist(8, [0x57, 0x45, 0x42, 0x50]))
  );
}

// Der Pfad hinter der Sitzung oder null ohne Bild; ?v= ändert sich mit jedem neuen Bild, damit die App ihren Speicher danach richten kann. Setzt einen Join auf profilbild voraus
export const bildUrl = sql<
  string | null
>`case when ${profilbild.userId} is null then null else '/api/v1/personen/' || ${profilbild.userId} || '/bild?v=' || (extract(epoch from ${profilbild.geaendertAm}) * 1000)::bigint end`;
