import { sql, type SQL } from "drizzle-orm";
import { programmBeginn } from "./rechte.js";

// Ein Wert für alle Einheiten (ANMELDEFENSTER_TAGE); die Anmeldung öffnet so viele Kalendertage vor dem Beginn
export const ANMELDEFENSTER_STANDARD = 42;

// Der Schweizer Kalendertag, ab dem sich anmelden lässt (yyyy-mm-dd); die Zahl kommt als Parameter, nie aus der Anfrage
export const anmeldungAb = (tage: number): SQL<string> =>
  sql`((${programmBeginn} at time zone 'Europe/Zurich')::date - ${tage}::int)`;

// Das Fenster ist offen, sobald der Tag erreicht ist; die Uhr der Datenbank entscheidet
export const fensterOffen = (tage: number): SQL<boolean> =>
  sql`(${anmeldungAb(tage)} <= (now() at time zone 'Europe/Zurich')::date)`;

// Aktiv, nicht begonnen und im Fenster: nur dann lässt sich antworten
export const antwortOffen = (tage: number): SQL<boolean> =>
  sql`(programm.status = 'aktiv' and ${programmBeginn} > now() and ${fensterOffen(tage)})`;

// «23.01.2027» für die Meldung bei 409
export const schweizerDatum = (tag: string) =>
  tag.split("-").reverse().join(".");
