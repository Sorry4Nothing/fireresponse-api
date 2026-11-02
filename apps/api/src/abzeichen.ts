// Prüfung und Bereinigung der Abzeichen-Bilder der Ränge (SR-23). Ohne node:* und process: Die Route zieht diese Datei in AppType. Der Typ ergibt sich aus den Bytes, nie aus Header oder Dateiendung.

// Passt zur CHECK-Regel der Tabelle rang (octet_length <= 512000)
export const ABZEICHEN_MAX_BYTES = 500 * 1024;

export class AbzeichenFehler extends Error {}

const fehler = (text: string): never => {
  throw new AbzeichenFehler(text);
};

// Hochformat 100:130, wie im Design; 5 % Spiel, damit gerundete Pixelmasse durchgehen
const VERHAELTNIS = 100 / 130;
const TOLERANZ = 0.05;
const passtZumVerhaeltnis = (breite: number, hoehe: number) =>
  breite > 0 &&
  hoehe > 0 &&
  Math.abs(breite / hoehe - VERHAELTNIS) <= VERHAELTNIS * TOLERANZ;

export type Abzeichen = { typ: "svg" | "png"; inhalt: Uint8Array };

const PNG_KOPF = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Nur diese Blöcke bleiben: Text, Zeitstempel, EXIF und Profile fallen weg
const PNG_BLOECKE = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);

function pruefePng(daten: Uint8Array): Abzeichen {
  const ansicht = new DataView(daten.buffer, daten.byteOffset, daten.length);
  const teile: Uint8Array[] = [daten.subarray(0, 8)];
  let ab = 8;
  let breite = 0;
  let hoehe = 0;
  let ende = false;
  for (let n = 0; ab < daten.length; n++) {
    if (ab + 12 > daten.length) fehler("Das PNG ist beschädigt.");
    const laenge = ansicht.getUint32(ab);
    const name = String.fromCharCode(...daten.subarray(ab + 4, ab + 8));
    const bis = ab + 12 + laenge;
    if (bis > daten.length) fehler("Das PNG ist beschädigt.");
    if (n === 0) {
      if (name !== "IHDR" || laenge !== 13) fehler("Das PNG ist beschädigt.");
      breite = ansicht.getUint32(ab + 8);
      hoehe = ansicht.getUint32(ab + 12);
    }
    if (PNG_BLOECKE.has(name)) teile.push(daten.subarray(ab, bis));
    ab = bis;
    if (name === "IEND") {
      ende = true;
      break;
    }
  }
  // Nach IEND darf nichts mehr folgen
  if (!ende || ab !== daten.length) fehler("Das PNG ist beschädigt.");
  if (breite < 200 || hoehe < 260) {
    fehler("Das Bild ist zu klein: mindestens 200 × 260 Pixel.");
  }
  // Eine Obergrenze gegen Bilder, die beim Anzeigen viel Speicher brauchen
  if (breite > 4000 || hoehe > 5200) {
    fehler("Das Bild ist zu gross: höchstens 4000 × 5200 Pixel.");
  }
  if (!passtZumVerhaeltnis(breite, hoehe)) {
    fehler("Das Bild muss im Hochformat 100:130 sein.");
  }
  const inhalt = new Uint8Array(teile.reduce((s, t) => s + t.length, 0));
  let stelle = 0;
  for (const teil of teile) {
    inhalt.set(teil, stelle);
    stelle += teil.length;
  }
  return { typ: "png", inhalt };
}

// Erlaubte Elemente; alles andere (script, style, image, foreignObject, a, animate, set, …) fällt samt Inhalt weg
const ELEMENTE = new Set([
  "svg",
  "g",
  "defs",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "use",
]);
const MIT_TEXT = new Set(["text", "tspan", "title", "desc"]);
// Zeichnende Elemente: Ohne eines wäre das Bild leer
const ZEICHNEND = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
]);
// Nur Darstellung und Geometrie; kein style, class, on*, Animation oder Verweis nach aussen
const ATTRIBUTE = new Set([
  "id",
  "viewBox",
  "preserveAspectRatio",
  "width",
  "height",
  "x",
  "y",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x1",
  "y1",
  "x2",
  "y2",
  "d",
  "points",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "clip-path",
  "clip-rule",
  "mask",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "fx",
  "fy",
  "fr",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "textLength",
  "lengthAdjust",
  "dx",
  "dy",
  "letter-spacing",
  "href",
  "xlink:href",
  "xmlns",
]);
const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_ELEMENTE = 5000;
const MAX_TIEFE = 32;
const MAX_WERT = 100_000;

// Nur die fünf Entitäten und Zeichenverweise; eine eigene Entität (DOCTYPE) gibt es nicht
const FREMDE_ENTITAET =
  /&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/;
const URL_BEZUG = /url\(\s*([^)]*?)\s*\)/gi;

// Gibt den Wert zurück oder undefined, wenn er etwas nach aussen oder Skript enthält
function sauberer(name: string, wert: string): string | undefined {
  if (wert.length > MAX_WERT || FREMDE_ENTITAET.test(wert)) return undefined;
  const klar = wert.replace(/&#x?[0-9a-f]+;/gi, "x").toLowerCase();
  if (/javascript:|data:|expression\(|@import|<|>/.test(klar)) return undefined;
  for (const [, ziel] of wert.matchAll(URL_BEZUG)) {
    if (!/^#[\w.-]+$/.test(ziel.replace(/^['"]|['"]$/g, ""))) return undefined;
  }
  if (name === "href" || name === "xlink:href") {
    return /^#[\w.-]+$/.test(wert) ? wert : undefined;
  }
  if (name === "xmlns") return wert === SVG_NS ? wert : undefined;
  return wert;
}

// Klebrig (y): Sie treffen nur an lastIndex, ohne den Rest des Textes zu kopieren
const TAG_ANFANG =
  /<([A-Za-z][\w:.-]*)((?:\s+[^\s=/>"']+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
const TAG_ENDE = /<\/([A-Za-z][\w:.-]*)\s*>/y;
const ATTRIBUT = /([^\s=/>"']+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g;

function pruefeSvg(daten: Uint8Array): Abzeichen {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(daten);
  } catch {
    return fehler("Die SVG-Datei ist kein gültiges UTF-8.");
  }
  text = text.replace(/^\\uFEFF/, "");
  const stack: { name: string; behalten: boolean }[] = [];
  let ausgabe = "";
  let ab = 0;
  let elemente = 0;
  let wurzelFertig = false;
  let zeichnend = false;
  let viewBox: number[] | undefined;
  const klebt = (muster: RegExp) => {
    muster.lastIndex = ab;
    return muster.exec(text);
  };

  while (ab < text.length) {
    if (text[ab] !== "<") {
      const bis = text.indexOf("<", ab);
      const inhalt = text.slice(ab, bis === -1 ? text.length : bis);
      ab = bis === -1 ? text.length : bis;
      const oben = stack.at(-1);
      if (inhalt.trim() === "") continue;
      // Text nur in den Elementen mit Text; sonst ist die Datei kein Bild, das wir kennen
      if (!oben || wurzelFertig) fehler("Die SVG-Datei ist ungültig.");
      if (FREMDE_ENTITAET.test(inhalt)) fehler("Die SVG-Datei ist ungültig.");
      if (oben!.behalten && MIT_TEXT.has(oben!.name)) ausgabe += inhalt;
      continue;
    }
    if (text.startsWith("<!--", ab)) {
      const bis = text.indexOf("-->", ab + 4);
      if (bis === -1) fehler("Die SVG-Datei ist ungültig.");
      ab = bis + 3;
      continue;
    }
    if (text.startsWith("<?", ab)) {
      // Nur die XML-Deklaration ganz am Anfang
      const bis = text.indexOf("?>", ab);
      if (ab !== 0 || bis === -1 || !/^<\?xml[\s?]/.test(text)) {
        fehler("Die SVG-Datei ist ungültig.");
      }
      ab = bis + 2;
      continue;
    }
    // DOCTYPE, ENTITY, CDATA
    if (text.startsWith("<!", ab)) fehler("Die SVG-Datei ist ungültig.");
    const ende = klebt(TAG_ENDE);
    if (ende) {
      const oben = stack.pop();
      if (!oben || oben.name !== ende[1]) fehler("Die SVG-Datei ist ungültig.");
      if (oben!.behalten) ausgabe += `</${oben!.name}>`;
      if (stack.length === 0) wurzelFertig = true;
      ab += ende[0].length;
      continue;
    }
    const anfang = klebt(TAG_ANFANG);
    if (!anfang || wurzelFertig) return fehler("Die SVG-Datei ist ungültig.");
    const [gesamt, name, attribute, leer] = anfang;
    ab += gesamt.length;
    if (++elemente > MAX_ELEMENTE || stack.length >= MAX_TIEFE) {
      fehler("Die SVG-Datei ist zu verschachtelt.");
    }
    if (stack.length === 0 && name !== "svg") {
      fehler("Die Datei ist keine SVG-Grafik.");
    }
    const elternBehalten = stack.length === 0 || stack.at(-1)!.behalten;
    const behalten = elternBehalten && ELEMENTE.has(name);
    if (behalten) {
      let attr = "";
      const gesehen = new Set<string>();
      for (const [, an, doppelt, einfach] of attribute.matchAll(ATTRIBUT)) {
        // Doppelte Attribute sind in XML ungültig
        if (gesehen.has(an)) fehler("Die SVG-Datei ist ungültig.");
        gesehen.add(an);
        if (!ATTRIBUTE.has(an)) continue;
        const wert = sauberer(an, doppelt ?? einfach ?? "");
        if (wert === undefined) continue;
        if (an === "xmlns") continue;
        if (name === "svg" && stack.length === 0 && an === "viewBox") {
          viewBox = wert
            .trim()
            .split(/[\s,]+/)
            .map(Number);
        }
        // Das Attribut ohne Namensraum: Der Namensraum xlink wird nicht deklariert
        const ausName = an === "xlink:href" ? "href" : an;
        attr += ` ${ausName}="${wert.replaceAll('"', "&quot;")}"`;
      }
      if (name === "svg" && stack.length === 0) {
        attr = ` xmlns="${SVG_NS}"${attr}`;
      }
      if (ZEICHNEND.has(name)) zeichnend = true;
      ausgabe += leer ? `<${name}${attr}/>` : `<${name}${attr}>`;
    }
    if (leer) {
      if (stack.length === 0) wurzelFertig = true;
    } else {
      stack.push({ name, behalten });
    }
  }
  if (stack.length > 0 || !wurzelFertig) fehler("Die SVG-Datei ist ungültig.");
  if (!zeichnend) fehler("Die SVG-Datei enthält keine Zeichnung.");
  if (viewBox?.length !== 4 || viewBox.some((n) => !Number.isFinite(n))) {
    fehler("Die SVG-Datei braucht ein viewBox.");
  }
  if (!passtZumVerhaeltnis(viewBox![2], viewBox![3])) {
    fehler("Das Bild muss im Hochformat 100:130 sein.");
  }
  return { typ: "svg", inhalt: new TextEncoder().encode(ausgabe) };
}

// Wirft AbzeichenFehler mit einem Text für die Verwaltung (nie ein Teil der Eingabe). Gibt die bereinigten Bytes zurück, die in die Datenbank gehören
export function pruefeAbzeichen(daten: Uint8Array): Abzeichen {
  if (daten.length === 0) fehler("Die Datei ist leer.");
  if (daten.length > ABZEICHEN_MAX_BYTES) {
    fehler("Die Datei ist grösser als 500 KB.");
  }
  if (PNG_KOPF.every((byte, i) => daten[i] === byte)) return pruefePng(daten);
  // SVG beginnt mit Text: erstes Zeichen nach Leerraum und BOM ist «<»
  const anfang = new TextDecoder().decode(daten.subarray(0, 64));
  if (/^[\s\\uFEFF]*</.test(anfang)) return pruefeSvg(daten);
  return fehler("Bitte ein SVG oder PNG senden.");
}
