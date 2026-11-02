import sharp from "sharp";
import { describe, expect, test } from "vitest";
import {
  ABZEICHEN_MAX_BYTES,
  AbzeichenFehler,
  pruefeAbzeichen,
} from "../src/abzeichen.js";

const kodiere = (text: string) => new TextEncoder().encode(text);
const dekodiere = (daten: Uint8Array) => new TextDecoder().decode(daten);

const svg = (innen: string, kopf = 'viewBox="0 0 100 130"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${kopf}>${innen}</svg>`;
const GUT = svg('<rect x="1" y="1" width="98" height="128" fill="#0A1230"/>');

const wirft = (daten: Uint8Array) => {
  try {
    pruefeAbzeichen(daten);
  } catch (fehler) {
    expect(fehler).toBeInstanceOf(AbzeichenFehler);
    return (fehler as Error).message;
  }
  throw new Error("Die Prüfung hat die Datei angenommen");
};

const png = (breite: number, hoehe: number) =>
  sharp({
    create: {
      width: breite,
      height: hoehe,
      channels: 3,
      background: "#3366cc",
    },
  })
    .png()
    .toBuffer();

describe("SVG bereinigen", () => {
  test("ein sauberes SVG bleibt als SVG erhalten", () => {
    const ergebnis = pruefeAbzeichen(kodiere(GUT));
    expect(ergebnis.typ).toBe("svg");
    expect(dekodiere(ergebnis.inhalt)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 130"><rect x="1" y="1" width="98" height="128" fill="#0A1230"/></svg>',
    );
  });

  test("Skripte, Ereignis-Attribute und Fremdelemente fallen weg, die Zeichnung bleibt", () => {
    const ergebnis = pruefeAbzeichen(
      kodiere(
        svg(
          [
            "<script>alert(1)</script>",
            '<rect width="10" height="10" onclick="alert(1)" onload="x()" style="fill:url(http://boese.invalid/a)"/>',
            '<foreignObject><iframe src="https://boese.invalid"></iframe></foreignObject>',
            '<image href="https://boese.invalid/a.png"/>',
            '<a href="javascript:alert(1)"><circle r="4"/></a>',
            "<style>@import url(https://boese.invalid/s.css);</style>",
            '<animate attributeName="x" to="1"/>',
            '<circle cx="5" cy="5" r="4" fill="red"/>',
          ].join(""),
        ),
      ),
    );
    const text = dekodiere(ergebnis.inhalt);
    expect(text).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 130"><rect width="10" height="10"/><circle cx="5" cy="5" r="4" fill="red"/></svg>',
    );
    for (const verboten of [
      "script",
      "onclick",
      "onload",
      "foreignObject",
      "iframe",
      "image",
      "javascript",
      "boese",
      "style",
      "animate",
    ]) {
      expect(text).not.toContain(verboten);
    }
  });

  test("Verweise nach aussen in erlaubten Attributen werden entfernt, Verweise innerhalb bleiben", () => {
    const text = dekodiere(
      pruefeAbzeichen(
        kodiere(
          svg(
            [
              '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs>',
              '<rect width="5" height="5" fill="url(#g)" stroke="url(https://boese.invalid/x)"/>',
              '<use href="https://boese.invalid/x.svg#a"/>',
              '<use xlink:href="#g"/>',
              '<path d="M0 0L5 5" fill="data:text/html,x"/>',
            ].join(""),
          ),
        ),
      ).inhalt,
    );
    expect(text).toContain('fill="url(#g)"');
    expect(text).toContain('<use href="#g"/>');
    expect(text).not.toContain("boese");
    expect(text).not.toContain("data:");
    expect(text).not.toContain("xlink");
  });

  test("Text im Bild bleibt, Markup im Text nicht", () => {
    const text = dekodiere(
      pruefeAbzeichen(
        kodiere(
          svg('<text x="5" y="5">JUGEND &amp; FEUER</text><circle r="1"/>'),
        ),
      ).inhalt,
    );
    expect(text).toContain('<text x="5" y="5">JUGEND &amp; FEUER</text>');
  });

  test("Text ausserhalb von Textelementen fällt weg", () => {
    const text = dekodiere(
      pruefeAbzeichen(kodiere(svg("hallo<rect/>"))).inhalt,
    );
    expect(text).not.toContain("hallo");
  });

  test.each([
    [
      "DOCTYPE mit Entität",
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "a">]>' + GUT,
    ],
    ["CDATA", svg("<rect/><![CDATA[x]]>")],
    ["kein SVG als Wurzel", "<html><body><rect/></body></html>"],
    ["zwei Wurzeln", GUT + GUT],
    ["nicht geschlossen", '<svg viewBox="0 0 100 130"><rect/>'],
    ["falsch verschachtelt", svg("<g><rect/></path></g>")],
    ["freie Entität im Text", svg("<text>&boese;</text><rect/>")],
    ["doppeltes Attribut", svg('<rect width="1" width="2"/>')],
    ["keine Zeichnung", svg("<defs/>")],
    ["ohne viewBox", svg("<rect/>", 'width="100" height="130"')],
    ["falsches Verhältnis", svg("<rect/>", 'viewBox="0 0 100 100"')],
    ["Querformat", svg("<rect/>", 'viewBox="0 0 130 100"')],
  ])("%s wird abgelehnt", (_name, text) => {
    expect(wirft(kodiere(text))).toBeTruthy();
  });

  test("zu tief verschachtelt wird abgelehnt", () => {
    const tief = svg("<g>".repeat(40) + "<rect/>" + "</g>".repeat(40));
    expect(wirft(kodiere(tief))).toMatch(/verschachtelt/);
  });

  test("ungültiges UTF-8 wird abgelehnt", () => {
    expect(wirft(Uint8Array.from([0x3c, 0x73, 0xff, 0xfe, 0x3e]))).toBeTruthy();
  });
});

describe("PNG prüfen", () => {
  test("ein PNG im Verhältnis 100:130 wird angenommen", async () => {
    const ergebnis = pruefeAbzeichen(await png(200, 260));
    expect(ergebnis.typ).toBe("png");
    // Das Ergebnis ist weiter ein lesbares PNG
    const meta = await sharp(Buffer.from(ergebnis.inhalt)).metadata();
    expect([meta.width, meta.height]).toEqual([200, 260]);
  });

  test("Textblöcke und Metadaten werden entfernt", async () => {
    const mitText = await sharp(await png(200, 260))
      .withMetadata({ exif: { IFD0: { Copyright: "Geheim" } } })
      .png()
      .toBuffer();
    const ergebnis = pruefeAbzeichen(mitText);
    expect(Buffer.from(ergebnis.inhalt).includes("Geheim")).toBe(false);
    expect(Buffer.from(ergebnis.inhalt).includes("eXIf")).toBe(false);
  });

  test("zu klein, falsches Verhältnis und zu gross werden abgelehnt", async () => {
    expect(wirft(await png(100, 130))).toMatch(/zu klein/);
    expect(wirft(await png(400, 300))).toMatch(/Hochformat/);
    expect(wirft(await png(300, 300))).toMatch(/Hochformat/);
    expect(wirft(await png(4001, 5201))).toMatch(/zu gross/);
  });

  test("ein abgeschnittenes oder erweitertes PNG wird abgelehnt", async () => {
    const gut = await png(200, 260);
    expect(wirft(gut.subarray(0, gut.length - 20))).toMatch(/beschädigt/);
    expect(wirft(Buffer.concat([gut, Buffer.from("nachher")]))).toMatch(
      /beschädigt/,
    );
  });
});

describe("Typ und Grösse", () => {
  test("andere Formate werden abgelehnt, auch mit Bildendung im Inhalt", () => {
    expect(wirft(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).toMatch(
      /SVG oder PNG/,
    );
    expect(wirft(kodiere("GIF89a..."))).toMatch(/SVG oder PNG/);
    expect(wirft(new Uint8Array(0))).toMatch(/leer/);
  });

  test("mehr als 500 KB wird abgelehnt", () => {
    const gross = kodiere(
      svg(`<!--${"x".repeat(ABZEICHEN_MAX_BYTES)}--><rect/>`),
    );
    expect(wirft(gross)).toMatch(/500 KB/);
  });
});
