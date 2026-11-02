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
};

export type IcsErgebnis = {
  termine: IcsTermin[];
  // Jede UID im Kalender, auch die eines Termins, den wir nicht lesen konnten: Er gilt nicht als gestrichen
  uids: Set<string>;
};

export class IcsFehler extends Error {}

type Zeile = { name: string; parameter: string; wert: string };

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

// Lodur hängt dem Titel ein wörtliches «\n» an
const titelBereinigen = (wert: string) =>
  entschluesseln(wert)
    .replace(/(?:\s|\\n)+$/, "")
    .trim();

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

function zeitpunkt(wert: string) {
  const m = /^(\d{8})T(\d{2})(\d{2})(\d{2})Z$/.exec(wert);
  const t = m && tag(m[1]!);
  if (!m || !t) return null;
  const [h, min, s] = [Number(m[2]), Number(m[3]), Number(m[4])];
  if (h > 23 || min > 59 || s > 60) return null;
  return new Date(t.getTime() + ((h * 60 + min) * 60 + Math.min(s, 59)) * 1000);
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
  const beginn = zeitpunkt(von.wert);
  const ende = bis ? zeitpunkt(bis.wert) : beginn;
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
