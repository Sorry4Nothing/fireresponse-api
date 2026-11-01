import { z } from "zod";
import { BENUTZERNAME_MAX, BENUTZERNAME_MIN } from "./benutzername.js";

// eltern: Teilnehmende mit Konto der Eltern, selbst: Teilnehmende mit eigenem Konto, ohne: nur die Person, Konten folgen später
export type Art = "eltern" | "selbst" | "ohne" | "auslassen";
export type Status =
  "neu" | "vorhanden" | "doppelt" | "ungueltig" | "ausgelassen";

export interface Zeile {
  vorname: string;
  nachname: string;
  art: Art;
  // Nur bei art «eltern»: ein Elternteil, das antwortet
  elternVorname?: string;
  elternNachname?: string;
}

export interface Ergebnis {
  nr: number;
  status: Status;
  art: Art;
  // Das neue Konto: bei «selbst» das der Person, bei «eltern» das der Eltern; fehlt, wenn die Eltern schon in einer Zeile weiter oben stehen
  benutzername?: string;
  // Nummer der Zeile, deren neues Elternkonto auch diese Person bekommt (Geschwister)
  gleicheEltern?: number;
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
  if (basis.length < BENUTZERNAME_MIN) basis = `konto${basis}`;
  for (let n = 1; ; n++) {
    const endung = n === 1 ? "" : String(n);
    const kandidat = basis.slice(0, BENUTZERNAME_MAX - endung.length) + endung;
    if (!belegt.has(kandidat)) return kandidat;
  }
}

// Dieselben Grenzen wie beim Anlegen einer Person (100 je Namensteil)
const name = z.string().trim().min(1).max(100);
const personFelder = z.strictObject({ vorname: name, nachname: name });

export interface Bestand {
  // personSchluessel der Teilnehmenden der Einheit
  teilnehmende: ReadonlySet<string>;
  // user.username in Kleinschreibung, im ganzen System
  benutzernamen: ReadonlySet<string>;
}

export interface Plan extends Ergebnis {
  // Bereinigte Werte, nur bei Status «neu»
  vorname?: string;
  nachname?: string;
  elternVorname?: string;
  elternNachname?: string;
}

export function pruefeZeilen(zeilen: readonly Zeile[], bestand: Bestand) {
  const gesehen = new Set<string>();
  // Eltern, die diese Datei schon anlegt: Geschwister teilen ein Konto
  const elternInDatei = new Map<string, number>();
  const belegt = new Set(bestand.benutzernamen);
  const plan: Plan[] = zeilen.map((zeile, nr) => {
    const { art } = zeile;
    if (art === "auslassen") return { nr, art, status: "ausgelassen" };
    const felder = personFelder.safeParse({
      vorname: zeile.vorname,
      nachname: zeile.nachname,
    });
    const eltern =
      art === "eltern"
        ? personFelder.safeParse({
            vorname: zeile.elternVorname ?? "",
            nachname: zeile.elternNachname ?? "",
          })
        : undefined;
    if (!felder.success || (eltern && !eltern.success)) {
      const leer = [
        zeile.vorname,
        zeile.nachname,
        ...(art === "eltern"
          ? [zeile.elternVorname, zeile.elternNachname]
          : []),
      ].some((t) => !t?.trim());
      return {
        nr,
        art,
        status: "ungueltig",
        grund: leer
          ? "Vor- und Nachname sind nötig, bei Eltern auch deren Name."
          : "Ein Name ist zu lang.",
      };
    }
    const { vorname, nachname } = felder.data;
    const schluessel = personSchluessel(vorname, nachname);
    if (bestand.teilnehmende.has(schluessel)) {
      return {
        nr,
        art,
        status: "vorhanden",
        grund: "Eine Person mit diesem Namen gibt es schon.",
      };
    }
    if (gesehen.has(schluessel)) {
      return {
        nr,
        art,
        status: "doppelt",
        grund: "Der Name kommt weiter oben in der Datei schon vor.",
      };
    }
    gesehen.add(schluessel);
    const neu: Plan = { nr, art, status: "neu", vorname, nachname };
    if (art === "selbst") {
      neu.benutzername = erzeugeBenutzername(vorname, nachname, belegt);
      belegt.add(neu.benutzername);
    }
    if (art === "eltern" && eltern?.success) {
      const { vorname: ev, nachname: en } = eltern.data;
      neu.elternVorname = ev;
      neu.elternNachname = en;
      const frueher = elternInDatei.get(personSchluessel(ev, en));
      if (frueher !== undefined) {
        neu.gleicheEltern = frueher;
      } else {
        elternInDatei.set(personSchluessel(ev, en), nr);
        neu.benutzername = erzeugeBenutzername(ev, en, belegt);
        belegt.add(neu.benutzername);
      }
    }
    return neu;
  });
  const summe = {
    neu: 0,
    vorhanden: 0,
    doppelt: 0,
    ungueltig: 0,
    ausgelassen: 0,
    konten: 0,
  };
  for (const p of plan) {
    summe[p.status]++;
    if (p.status === "neu" && p.benutzername !== undefined) summe.konten++;
  }
  return { plan, summe };
}

// Nur das, was die Antwort der Vorschau zeigt: keine Namen
export const alsErgebnis = ({
  nr,
  status,
  art,
  benutzername,
  gleicheEltern,
  grund,
}: Plan) => ({
  nr,
  status,
  art,
  ...(benutzername !== undefined && { benutzername }),
  ...(gleicheEltern !== undefined && { gleicheEltern }),
  ...(grund !== undefined && { grund }),
});
