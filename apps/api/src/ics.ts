// Liest den ICS-Kalender einer Einheit in Lodur. Gelesen wird nur, was die API speichert: UID, Titel, Zeiten und die Felder Thema/Dienst, Info und Aufgebot der Beschreibung. «Verantwortlich» wird nie übernommen.

export type IcsTermin = {
  uid: string;
  titel: string;
  ganztaegig: boolean;
  beginn: Date | null;
  ende: Date | null;
  // yyyy-mm-dd; tagBis ist der letzte Tag (DTEND ist in ICS exklusiv)
  tagVon: string | null;
  tagBis: string | null;
  thema: string | null;
  info: string | null;
  aufgebot: string | null;
  // Spalte «Art» der HTML-Terminliste; der ICS-Kalender hat sie nicht und bekommt ICS_ART
  art: string | null;
};

// Ohne Art lässt sich ein Termin nicht anmelden (anmeldbar); die Einheit gibt diese Art in der Verwaltung frei
export const ICS_ART = "Termin";

// Auch das Ergebnis der HTML-Terminliste (lodur-html.ts) hat diese Form
export type IcsErgebnis = {
  termine: IcsTermin[];
  // Jede UID im Kalender, auch die eines Termins, den wir nicht lesen konnten: Er gilt nicht als gestrichen
  uids: Set<string>;
};

export class IcsFehler extends Error {}

type Zeile = { name: string; parameter: string; zone?: string; wert: string };

// Folding: Eine Zeile, die mit Leerzeichen oder Tab beginnt, setzt die vorige fort
function zeilen(text: string): Zeile[] {
  const ergebnis: Zeile[] = [];
  for (const roh of text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    // Der erste Doppelpunkt ausserhalb von Anführungszeichen trennt Name samt Parametern vom Wert
    let imText = false;
    let doppelpunkt = -1;
    for (let i = 0; i < roh.length; i++) {
      if (roh[i] === '"') imText = !imText;
      else if (roh[i] === ":" && !imText) {
        doppelpunkt = i;
        break;
      }
    }
    if (doppelpunkt < 1) continue;
    const kopf = roh.slice(0, doppelpunkt);
    const semikolon = kopf.indexOf(";");
    ergebnis.push({
      name: (semikolon < 0 ? kopf : kopf.slice(0, semikolon)).toUpperCase(),
      parameter: semikolon < 0 ? "" : kopf.slice(semikolon).toUpperCase(),
      zone: /;TZID="?([^;":]+)/i.exec(kopf)?.[1],
      wert: roh.slice(doppelpunkt + 1),
    });
  }
  return ergebnis;
}

// TEXT: \n, \N, \, \; und \\ in einem Durchgang, damit «\\n» ein Backslash und ein n bleibt
const entschluesseln = (wert: string) =>
  wert.replace(/\\([nN,;\\])/g, (_, z: string) =>
    z === "n" || z === "N" ? "\n" : z,
  );

// Datum und Zeit gehören in beginn/ende und tagVon/tagBis, nicht in den Titel; bleibt nichts übrig, gilt der Titel unverändert
const UHR = String.raw`\d{1,2}[.:]\d{2}`;
const DATUM_ZEIT = new RegExp(
  [
    String.raw`\b\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})(?!\d)`,
    String.raw`\b\d{1,2}\.\d{1,2}\.(?!\d)`,
    String.raw`\b${UHR}\s*(?:[-–]|bis)\s*${UHR}(?:\s*Uhr)?`,
    String.raw`\b${UHR}\s*Uhr\b`,
  ].join("|"),
  "gi",
);
export function titelOhneDatum(titel: string): string {
  const rest = titel
    .replace(DATUM_ZEIT, " ")
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    // Übrig gebliebene Trennzeichen doppelt, am Rand oder als Verbindungswort am Ende
    .replace(/(?:\s*[-–,:|/]\s*){2,}/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–,:|/]+|[\s\-–,:|/]+$/g, "")
    .replace(/\s+(?:am|vom|um|ab|den|von|bis)$/i, "")
    .trim();
  return rest || titel;
}

// Lodur hängt dem Titel ein wörtliches «\n» an
const titelBereinigen = (wert: string) =>
  titelOhneDatum(
    entschluesseln(wert)
      .replace(/(?:\s|\\n)+$/, "")
      .trim(),
  );

function tag(wert: string) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(wert);
  if (!m) return null;
  const [j, mo, t] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(j, mo - 1, t));
  // Gültig nur, wenn das Datum nach der Umrechnung gleich bleibt (kein 31. Februar); PostgreSQL lehnt das Jahr 0000 ab
  if (
    j < 1970 ||
    j > 2200 ||
    d.getUTCMonth() !== mo - 1 ||
    d.getUTCDate() !== t
  )
    return null;
  return d;
}

const tagText = (d: Date) => d.toISOString().slice(0, 10);

// Versatz der Zeitzone zu UTC in Millisekunden an diesem Zeitpunkt; wirft RangeError bei unbekannter Zone
function zonenVersatz(zone: string, ms: number) {
  const teile = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, Number(p.value)]),
  );
  const lokal = Date.UTC(
    teile.year!,
    teile.month! - 1,
    teile.day!,
    teile.hour!,
    teile.minute!,
    teile.second!,
  );
  return lokal - Math.floor(ms / 1000) * 1000;
}

// «…Z» ist UTC; «…» mit Parameter TZID (membear) ist Ortszeit dieser Zone. Ohne beides (schwebende Zeit) ist der Termin nicht lesbar
function zeitpunkt(wert: string, zone?: string) {
  const m = /^(\d{8})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(wert);
  const t = m && tag(m[1]!);
  if (!m || !t || (!m[5] && !zone)) return null;
  const [h, min, s] = [Number(m[2]), Number(m[3]), Number(m[4])];
  if (h > 23 || min > 59 || s > 60) return null;
  const wand = t.getTime() + ((h * 60 + min) * 60 + Math.min(s, 59)) * 1000;
  if (m[5]) return new Date(wand);
  try {
    // Zweimal, damit der Versatz am richtigen Zeitpunkt gilt (Sommerzeitwechsel)
    const erster = wand - zonenVersatz(zone!, wand);
    return new Date(wand - zonenVersatz(zone!, erster));
  } catch {
    return null;
  }
}

// Felder der Beschreibung; Zeilen ohne Feldnamen gehören zum davor stehenden Feld
const FELD = /^(Thema\/Dienst|Info|Verantwortlich|Aufgebot):[ \t]*(.*)$/i;

function beschreibung(wert: string) {
  const felder: Record<string, string[]> = {};
  let aktuell: string[] | undefined;
  for (const zeile of entschluesseln(wert).split(/\r?\n/)) {
    const m = FELD.exec(zeile);
    if (m) {
      const name = m[1]!.toLowerCase();
      // Verantwortlich: Die Zeilen gehen ins Leere
      aktuell =
        name === "verantwortlich" ? undefined : (felder[name] = [m[2]!]);
    } else aktuell?.push(zeile);
  }
  const text = (name: string) => felder[name]?.join("\n").trim() || null;
  return {
    thema: text("thema/dienst"),
    info: text("info"),
    aufgebot: text("aufgebot"),
  };
}

function termin(eigenschaften: Zeile[]): IcsTermin | null {
  const finde = (name: string) => eigenschaften.find((z) => z.name === name);
  const uid = finde("UID")?.wert.trim();
  const von = finde("DTSTART");
  if (!uid || !von) return null;
  const bis = finde("DTEND");
  const basis = {
    uid,
    art: ICS_ART,
    titel: titelBereinigen(finde("SUMMARY")?.wert ?? ""),
    ...beschreibung(finde("DESCRIPTION")?.wert ?? ""),
  };
  if (
    von.parameter.includes("VALUE=DATE") &&
    !von.parameter.includes("DATE-TIME")
  ) {
    const anfang = tag(von.wert);
    if (!anfang) return null;
    // DTEND ist der Tag nach dem letzten
    const schluss = bis ? tag(bis.wert) : null;
    if (bis && !schluss) return null;
    const letzter = schluss ? new Date(schluss.getTime() - 86_400_000) : anfang;
    return {
      ...basis,
      ganztaegig: true,
      beginn: null,
      ende: null,
      tagVon: tagText(anfang),
      tagBis: tagText(letzter < anfang ? anfang : letzter),
    };
  }
  const beginn = zeitpunkt(von.wert, von.zone);
  const ende = bis ? zeitpunkt(bis.wert, bis.zone ?? von.zone) : beginn;
  if (!beginn || !ende) return null;
  return {
    ...basis,
    ganztaegig: false,
    beginn,
    ende: ende < beginn ? beginn : ende,
    tagVon: null,
    tagBis: null,
  };
}

export function leseIcs(text: string): IcsErgebnis {
  const alle = zeilen(text);
  if (!alle.some((z) => z.name === "BEGIN" && z.wert === "VCALENDAR")) {
    throw new IcsFehler("kein Kalender");
  }
  const termine = new Map<string, IcsTermin>();
  const uids = new Set<string>();
  let aktuell: Zeile[] | undefined;
  // Tiefe in Unterkomponenten wie VALARM: Ihre Eigenschaften (DESCRIPTION) gehören nicht zum Termin
  let tiefe = 0;
  for (const zeile of alle) {
    if (zeile.name === "BEGIN" && zeile.wert === "VEVENT" && !aktuell) {
      aktuell = [];
      tiefe = 0;
    } else if (!aktuell) continue;
    else if (zeile.name === "BEGIN") tiefe++;
    else if (zeile.name === "END" && tiefe > 0) tiefe--;
    else if (zeile.name === "END" && zeile.wert === "VEVENT") {
      const t = termin(aktuell);
      const uid = aktuell.find((z) => z.name === "UID")?.wert.trim();
      const abgesagt = aktuell.some(
        (z) =>
          z.name === "STATUS" && z.wert.trim().toUpperCase() === "CANCELLED",
      );
      // Ein gestrichener Termin zählt wie ein fehlender
      if (uid && !abgesagt) uids.add(uid);
      if (t && !abgesagt) termine.set(t.uid, t);
      aktuell = undefined;
    } else if (tiefe === 0) aktuell.push(zeile);
  }
  return { termine: [...termine.values()], uids };
}
