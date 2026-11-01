// CSV lesen und schreiben, Spalten und Rollen vorschlagen. Reine Logik ohne DOM, damit sie sich in Node testen lässt.

export const MAX_ZEILEN = 500;
export const MAX_BYTES = 1024 * 1024;

// Reihenfolge der Stärke: Stufenleitung vor Leitung vor Kind vor Auslassen
const RANG = { auslassen: 0, kind: 1, leitung: 2, stufenleitung: 3 };
export const ARTEN = [
  ["kind", "Kind"],
  ["leitung", "Leitung"],
  ["stufenleitung", "Stufenleitung"],
  ["auslassen", "Auslassen"],
];

const TRENNER = [";", ",", "\t"];

// Zählt die Trenner der ersten Zeile ausserhalb von Anführungszeichen; bei Gleichstand gewinnt der erste der Liste
export function erkenneTrenner(text) {
  const zaehler = new Map(TRENNER.map((t) => [t, 0]));
  let innen = false;
  for (const z of text) {
    if (z === '"') innen = !innen;
    else if (!innen && (z === "\n" || z === "\r")) {
      if ([...zaehler.values()].some((n) => n > 0)) break;
    } else if (!innen && zaehler.has(z)) zaehler.set(z, zaehler.get(z) + 1);
  }
  let beste = ";";
  for (const t of TRENNER) {
    if (zaehler.get(t) > zaehler.get(beste)) beste = t;
  }
  return beste;
}

// Zeilen als Listen von Feldern: Anführungszeichen mit "" als Escape, Zeilenumbrüche in Feldern, CRLF; leere Zeilen fallen weg
export function parseCsv(text, trenner) {
  const zeilen = [];
  let zeile = [];
  let feld = "";
  let innen = false;
  const schliesse = () => {
    zeile.push(feld.trim());
    feld = "";
    if (zeile.some((f) => f !== "")) zeilen.push(zeile);
    zeile = [];
  };
  for (let i = 0; i < text.length; i++) {
    const z = text[i];
    if (innen) {
      if (z !== '"') feld += z;
      else if (text[i + 1] === '"') {
        feld += '"';
        i++;
      } else innen = false;
    } else if (z === '"' && feld === "") innen = true;
    else if (z === trenner) {
      zeile.push(feld.trim());
      feld = "";
    } else if (z === "\n" || z === "\r") {
      if (z === "\r" && text[i + 1] === "\n") i++;
      schliesse();
    } else feld += z;
  }
  if (feld !== "" || zeile.length > 0) schliesse();
  return zeilen;
}

// Bytes einer Datei als Text: erst streng UTF-8, sonst Windows-1252 (so liefern ältere Mitgliederdatenbanken ihren Export)
export function dekodiere(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

// Text einer Datei: Kopfzeile (erste nicht leere Zeile), Datenzeilen, erkannter Trenner
// «sep=;» in der ersten Zeile (Excel) legt den Trenner fest
export function liesCsv(text) {
  let inhalt = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let trenner;
  const sep = /^sep=(.)[ \t]*(?:\r\n|\n|\r|$)/i.exec(inhalt);
  if (sep) {
    trenner = sep[1];
    inhalt = inhalt.slice(sep[0].length);
  }
  trenner ??= erkenneTrenner(inhalt);
  const [kopf = [], ...zeilen] = parseCsv(inhalt, trenner);
  return { trenner, kopf, zeilen };
}

// Kleinbuchstaben ohne Akzente, Satzzeichen und Leerzeichen: «Vor-Name» und «vorname» sind gleich
export const normalisiere = (text) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const SYNONYME = {
  vorname: ["vorname", "rufname", "firstname", "givenname"],
  nachname: ["nachname", "name", "familienname", "lastname", "surname"],
  rolle: ["rolle", "rollen", "funktion", "typ", "art", "role"],
};

// Spaltennummern (0-basiert) oder -1; zuerst gilt die genaue Übereinstimmung der Kopfzeile, dann ein enthaltenes langes Synonym. Jede Spalte wird höchstens einmal vergeben.
export function schlageSpaltenVor(kopf) {
  const namen = kopf.map(normalisiere);
  const vergeben = new Set();
  const ergebnis = { vorname: -1, nachname: -1, rolle: -1 };
  const suche = (feld, passt) => {
    if (ergebnis[feld] >= 0) return;
    const i = namen.findIndex((n, j) => !vergeben.has(j) && passt(n));
    if (i >= 0) {
      ergebnis[feld] = i;
      vergeben.add(i);
    }
  };
  for (const feld of Object.keys(SYNONYME)) {
    suche(feld, (n) => SYNONYME[feld].includes(n));
  }
  for (const feld of Object.keys(SYNONYME)) {
    suche(feld, (n) =>
      SYNONYME[feld].some((s) => s.length >= 5 && n.includes(s)),
    );
  }
  return ergebnis;
}

// Spalte «Hauptebene» der Mitgliederdatenbank (Name der Abteilungsebene, in jeder Zeile gleich) oder -1
export const findeEbene = (kopf) =>
  kopf.findIndex((k) => normalisiere(k) === "hauptebene");

// Mehrere Werte in einer Zelle trennen , ; |; nie an «/»: «Teilnehmer/-in» bleibt ganz, ein « / » trennt die Untergruppe.
// Export der Mitgliederdatenbank: «Rolle (Zusatz) <Hauptebene> / Untergruppe»; übrig bleibt der Rollenname
export function teileRollen(zelle, ebene = "") {
  const suffix = ebene.trim().toLowerCase();
  return zelle
    .split(/[,;|]/)
    .map((w) => {
      let wert = w.split(" / ")[0].trim();
      if (suffix && wert.toLowerCase().endsWith(suffix)) {
        wert = wert.slice(0, -suffix.length);
      }
      return wert.replace(/\s*\([^)]*\)\s*$/, "").trim();
    })
    .filter(Boolean);
}

// Schlüssel eines Rollenwerts: ohne Gross-/Kleinschreibung und überzählige Leerzeichen
export const rollenSchluessel = (wert) =>
  wert.toLowerCase().replace(/\s+/g, " ").trim();

export function schlageArtVor(wert) {
  const n = wert.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  // Nur der Anfang zählt: «J+S-Lagerleitung» und «Abteilungsleiter/-in» bleiben ausgelassen
  if (/^stufenleit/.test(n)) return "stufenleitung";
  if (/^(gruppen)?leit/.test(n)) return "leitung";
  if (/^(kind|teilnehm)/.test(n)) return "kind";
  return "auslassen";
}

export function staerksteArt(arten) {
  return arten.reduce(
    (stark, art) => (RANG[art] > RANG[stark] ? art : stark),
    "auslassen",
  );
}

// Die Werte der Rollenspalte mit Anzahl der Zeilen, in der Reihenfolge des ersten Auftretens; eine leere Zelle zählt als Wert ""
export function verschiedeneRollen(zeilen, spalte, ebene = -1) {
  const gefunden = new Map();
  for (const zeile of zeilen) {
    const werte = teileRollen(zeile[spalte] ?? "", zeile[ebene] ?? "");
    const schluessel = new Set();
    for (const wert of werte.length > 0 ? werte : [""]) {
      const s = rollenSchluessel(wert);
      if (schluessel.has(s)) continue;
      schluessel.add(s);
      const alt = gefunden.get(s);
      if (alt) alt.anzahl++;
      else gefunden.set(s, { wert, schluessel: s, anzahl: 1 });
    }
  }
  return [...gefunden.values()];
}

// Schnellweg: Vor-/Nachname und Rollenspalte sind erkannt und mindestens eine Rolle passt zu Kind, Leitung oder Stufenleitung.
// Sonst entscheidet der Mensch (nichts raten): Spalten fehlen, es gibt keine Rollenspalte oder keine Rolle passt
export function kannSchnellweg(kopf, zeilen) {
  const s = schlageSpaltenVor(kopf);
  if (s.vorname < 0 || s.nachname < 0 || s.rolle < 0) return false;
  return verschiedeneRollen(zeilen, s.rolle, findeEbene(kopf)).some(
    (w) => schlageArtVor(w.wert) !== "auslassen",
  );
}

// Zeilen für die API. Mit Rollenspalte gilt die stärkste Art der zugeordneten Werte, sonst `einheit` für alle.
// spalten: { vorname, nachname, rolle } als Nummern oder -1; arten: Map Schlüssel -> Art
export function baueZeilen(zeilen, spalten, { arten, einheit, ebene = -1 }) {
  return zeilen.map((zeile) => {
    const feld = (i) => (i >= 0 ? (zeile[i] ?? "") : "");
    const werte =
      spalten.rolle >= 0
        ? teileRollen(feld(spalten.rolle), zeile[ebene] ?? "")
        : [];
    const art =
      spalten.rolle < 0
        ? einheit
        : staerksteArt(
            (werte.length > 0 ? werte : [""]).map(
              (w) => arten.get(rollenSchluessel(w)) ?? "auslassen",
            ),
          );
    return {
      vorname: feld(spalten.vorname),
      nachname: feld(spalten.nachname),
      art,
    };
  });
}

// Zelle, die ein Tabellenprogramm als Formel läse, bekommt ein Hochkomma davor
export const entschaerfe = (wert) =>
  /^[=+\-@\t\r]/.test(wert) ? `'${wert}` : wert;

// Zeilen als CSV-Text; Felder mit Trenner, Anführungszeichen oder Zeilenumbruch stehen in Anführungszeichen
export function schreibeCsv(zeilen, trenner = ";") {
  const feld = (w) =>
    new RegExp(`[${trenner}"\\r\\n]`).test(w)
      ? `"${w.replaceAll('"', '""')}"`
      : w;
  return zeilen.map((z) => z.map(feld).join(trenner)).join("\r\n") + "\r\n";
}
