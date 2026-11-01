import { z } from "zod";
import { BENUTZERNAME_MAX, BENUTZERNAME_MIN } from "./benutzername.js";

export type Art = "kind" | "leitung" | "stufenleitung" | "auslassen";
export type Status =
  "neu" | "vorhanden" | "doppelt" | "ungueltig" | "ausgelassen";

export interface Zeile {
  vorname: string;
  nachname: string;
  art: Art;
}

export interface Ergebnis {
  nr: number;
  status: Status;
  art: Art;
  benutzername?: string;
  grund?: string;
}

// Ohne Gross-/Kleinschreibung, Akzente und überzählige Leerzeichen
export function normalisiereName(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

// Gleicher Schlüssel für Kind (vorname, nachname) und Konto (user.name = «Vorname Nachname»)
export const personSchluessel = (vorname: string, nachname: string) =>
  normalisiereName(`${vorname} ${nachname}`);

const UMLAUTE: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
};

function bereinige(text: string) {
  return text
    .toLowerCase()
    .replace(/[äöüß]/g, (z) => UMLAUTE[z])
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9._-]/g, "");
}

// Rein und deterministisch: Vorschau und Import rufen dieselbe Funktion mit derselben Menge belegter Namen (klein geschrieben) auf
export function erzeugeBenutzername(
  vorname: string,
  nachname: string,
  belegt: ReadonlySet<string>,
) {
  const kuerzen = (t: string) => t.replace(/^[._-]+|[._-]+$/g, "");
  let basis = kuerzen(
    [bereinige(vorname), bereinige(nachname)].filter(Boolean).join("."),
  );
  if (basis.length < BENUTZERNAME_MIN) basis = `leitung${basis}`;
  for (let n = 1; ; n++) {
    const endung = n === 1 ? "" : String(n);
    const kandidat = basis.slice(0, BENUTZERNAME_MAX - endung.length) + endung;
    if (!belegt.has(kandidat)) return kandidat;
  }
}

// Dieselben Grenzen wie beim Anlegen von Kind (100) und Person (100 je Namensteil)
const zeilenFelder = z.object({
  vorname: z.string().trim().min(1).max(100),
  nachname: z.string().trim().min(1).max(100),
});

export interface Bestand {
  // personSchluessel der Kinder und der Konten der Abteilung
  kinder: ReadonlySet<string>;
  konten: ReadonlySet<string>;
  // user.username in Kleinschreibung
  benutzernamen: ReadonlySet<string>;
}

export interface Plan extends Ergebnis {
  // Bereinigte Werte, nur bei Status «neu»
  vorname?: string;
  nachname?: string;
}

export function pruefeZeilen(zeilen: readonly Zeile[], bestand: Bestand) {
  const gesehen = { kind: new Set<string>(), leitung: new Set<string>() };
  const belegt = new Set(bestand.benutzernamen);
  const plan: Plan[] = zeilen.map((zeile, nr) => {
    const { art } = zeile;
    if (art === "auslassen") return { nr, art, status: "ausgelassen" };
    const felder = zeilenFelder.safeParse(zeile);
    if (!felder.success) {
      const leer = !zeile.vorname.trim() || !zeile.nachname.trim();
      return {
        nr,
        art,
        status: "ungueltig",
        grund: leer ? "Vor- und Nachname sind nötig." : "Der Name ist zu lang.",
      };
    }
    const { vorname, nachname } = felder.data;
    const gruppe = art === "kind" ? "kind" : "leitung";
    const schluessel = personSchluessel(vorname, nachname);
    const vorhanden = (gruppe === "kind" ? bestand.kinder : bestand.konten).has(
      schluessel,
    );
    if (vorhanden) {
      return {
        nr,
        art,
        status: "vorhanden",
        grund:
          gruppe === "kind"
            ? "Ein Kind mit diesem Namen gibt es schon."
            : "Ein Konto mit diesem Namen gibt es schon.",
      };
    }
    if (gesehen[gruppe].has(schluessel)) {
      return {
        nr,
        art,
        status: "doppelt",
        grund: "Der Name kommt weiter oben in der Datei schon vor.",
      };
    }
    gesehen[gruppe].add(schluessel);
    const neu: Plan = { nr, art, status: "neu", vorname, nachname };
    if (gruppe === "leitung") {
      neu.benutzername = erzeugeBenutzername(vorname, nachname, belegt);
      belegt.add(neu.benutzername);
    }
    return neu;
  });
  const summe = {
    neu: 0,
    vorhanden: 0,
    doppelt: 0,
    ungueltig: 0,
    ausgelassen: 0,
    kinder: 0,
    leitende: 0,
  };
  for (const p of plan) {
    summe[p.status]++;
    if (p.status === "neu") summe[p.art === "kind" ? "kinder" : "leitende"]++;
  }
  return { plan, summe };
}

// Nur das, was die Antwort der Vorschau zeigt: keine Namen
export const alsErgebnis = ({
  nr,
  status,
  art,
  benutzername,
  grund,
}: Plan) => ({
  nr,
  status,
  art,
  ...(benutzername !== undefined && { benutzername }),
  ...(grund !== undefined && { grund }),
});
