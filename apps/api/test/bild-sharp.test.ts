import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { kodiereProfilbild } from "../src/bild-sharp.js";

// Einfarbig: als PNG wenige KB, beim Dekodieren zählt nur die Kantenlänge
const png = (breite: number, hoehe: number) =>
  sharp({
    create: { width: breite, height: hoehe, channels: 3, background: "#fff" },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();

describe("Pixelgrenze (Profilbild)", () => {
  const kodiere = kodiereProfilbild;
  test.each([
    ["Handyfoto 12 MP", 4032, 3024],
    ["Handyfoto 12.5 MP", 4080, 3072],
    ["genau 16 Mio. Pixel", 4000, 4000],
  ])("%s (%i × %i) geht durch", async (_art, breite, hoehe) => {
    await expect(kodiere(await png(breite, hoehe))).resolves.toBeInstanceOf(
      Buffer,
    );
  });

  test("ein Bild über 16 Mio. Pixel wird abgelehnt", async () => {
    await expect(kodiere(await png(4000, 4001))).rejects.toThrow(
      "exceeds pixel limit",
    );
  });
});
