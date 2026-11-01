import sharp from "sharp";
import type { BildKodierer } from "./bild.js";

// Ohne Zwischenspeicher: Es kommen wenige, einmalige Bilder, und der Speicher soll nach der Anfrage frei sein
sharp.cache(false);

const SEITE = 256;
// Schutz vor Dekompressionsbomben: Ein 5-MB-PNG kann Milliarden Pixel enthalten. 16 Mio. Pixel decken ein Handyfoto mit 12 MP (4032 × 3024) ab, kosten beim Dekodieren mit 4 Bytes je Pixel rund 64 MB, und das Ergebnis hat ohnehin nur 256 px
const MAX_PIXEL = 16_000_000;

// Immer JPEG, quadratisch (Mitte), ohne EXIF, ICC und Ortsdaten: sharp übernimmt Metadaten nur mit withMetadata(). rotate() wendet die EXIF-Drehung vorher an, damit das Bild nicht kippt. Transparenz wird weiss
export const kodiereProfilbild: BildKodierer = async (daten) =>
  sharp(daten, { limitInputPixels: MAX_PIXEL, failOn: "error" })
    .rotate()
    .resize(SEITE, SEITE, { fit: "cover" })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 82 })
    .toBuffer();
