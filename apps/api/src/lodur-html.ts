import { createHash } from "node:crypto";
import { titelOhneDatum, type IcsErgebnis, type IcsTermin } from "./ics.js";
import { vonWanduhr } from "./zeitregeln/ausloesezeit.js";

// Liest die öffentliche Terminliste einer Einheit in Lodur (index.php?modul=13&what=10&year=…): eine HTML-Tabelle mit den Spalten Tag, Datum, Zeit, Thema | Dienst, Übungsstoff und Art. Das Ergebnis hat die Form des ICS-Parsers, damit der Sync beide gleich übernimmt.

export class SeitenFehler extends Error {}

// Die Seite eines Jahres ohne Termine hat den Rahmen, aber keine Tabelle; jede andere Seite (Anmeldung, Fehlerseite) gilt nicht als Kalender
const RAHMEN = /id=["']id_ubungen_parent["']|<table[^>]*\bid=["']default["']/i;
const TABELLE = /<table[^>]*\bid=["']default["'][^>]*>([\s\S]*?)<\/table>/i;

const ENTITAETEN: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  eacute: "é",
  egrave: "è",
  agrave: "à",
};

function text(zelle: string) {
  return zelle
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
      (voll, dez, hex, name) => {
        if (name) return ENTITAETEN[name] ?? voll;
        const code = hex ? parseInt(hex, 16) : Number(dez);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : voll;
      },
    )
    .replace(/\s+/g, " ")
    .trim();
}

// «16.01.2026» als UTC-Mitternacht; null bei einem Datum, das es nicht gibt (31.02.) oder PostgreSQL ablehnt
function tag(t: string) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  if (!m) return null;
  const [d, mo, j] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ergebnis = new Date(Date.UTC(j, mo - 1, d));
  return j >= 1970 &&
    j <= 2200 &&
    ergebnis.getUTCMonth() === mo - 1 &&
    ergebnis.getUTCDate() === d
    ? ergebnis
    : null;
}

const tagText = (d: Date) => d.toISOString().slice(0, 10);

// «17:30 - 22:00» oder «17:30»: Minuten seit Mitternacht; ohne oder mit unlesbarer Zeit null (der Termin gilt dann als ganztägig)
function zeit(t: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})(?:\s*-\s*(\d{1,2}):(\d{2}))?$/.exec(t);
  if (!m) return null;
  const [h1, m1, h2, m2] = [m[1]!, m[2]!, m[3] ?? m[1]!, m[4] ?? m[2]!].map(
    Number,
  ) as [number, number, number, number];
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  return [h1 * 60 + m1, h2 * 60 + m2];
}

const ortszeit = (t: Date, minuten: number) =>
  vonWanduhr(t.getTime() + minuten * 60_000);

function zeile(zellen: string[]): Omit<IcsTermin, "uid"> | null {
  const [, datum, uhr, thema, stoff, art] = zellen as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const [a, b] = datum.split(/\s*-\s*/);
  const von = tag(a ?? "");
  const bis = b === undefined ? von : tag(b);
  if (!von || !bis) return null;
  const letzter = bis < von ? von : bis;
  const z = uhr ? zeit(uhr) : null;
  const basis = {
    titel: titelOhneDatum(thema || art || "Termin"),
    thema: null,
    info: stoff || null,
    aufgebot: null,
    art: art || null,
  };
  if (!z) {
    return {
      ...basis,
      ganztaegig: true,
      beginn: null,
      ende: null,
      tagVon: tagText(von),
      tagBis: tagText(letzter),
    };
  }
  const beginn = ortszeit(von, z[0]);
  const ende = ortszeit(letzter, z[1]);
  return {
    ...basis,
    ganztaegig: false,
    beginn,
    ende: ende < beginn ? beginn : ende,
    tagVon: null,
    tagBis: null,
  };
}

export function leseLodurSeite(html: string): IcsErgebnis {
  if (!RAHMEN.test(html)) throw new SeitenFehler("keine Terminliste");
  const termine: IcsTermin[] = [];
  const gesehen = new Map<string, number>();
  for (const [, reihe] of (TABELLE.exec(html)?.[1] ?? "").matchAll(
    /<tr[^>]*>([\s\S]*?)<\/tr>/gi,
  )) {
    const zellen = [...reihe!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (m) => text(m[1]!),
    );
    const t = zellen.length >= 6 ? zeile(zellen) : null;
    if (!t) continue;
    // Lodur nennt keine ID. Der Schlüssel ist Beginn-Tag und Thema ohne die Zeit: Eine verschobene Zeit bleibt derselbe Termin (Änderung statt Absage und Neuanlage). Gleicher Schlüssel am selben Tag zählt in der Reihenfolge der Seite weiter
    const schluessel = createHash("sha256")
      .update(
        JSON.stringify([
          zellen[1]!.split(/\s*-\s*/)[0],
          zellen[3] || zellen[5],
        ]),
      )
      .digest("hex")
      .slice(0, 24);
    const n = (gesehen.get(schluessel) ?? 0) + 1;
    gesehen.set(schluessel, n);
    termine.push({ uid: `html-${schluessel}${n > 1 ? `-${n}` : ""}`, ...t });
  }
  return { termine, uids: new Set(termine.map((t) => t.uid)) };
}
