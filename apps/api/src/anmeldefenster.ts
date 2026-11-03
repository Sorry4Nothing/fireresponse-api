import { sql, type SQL } from "drizzle-orm";
import { programmBeginn } from "./rechte.js";

// Ein Wert für alle Einheiten (ANMELDEFENSTER_TAGE); die Anmeldung öffnet so viele Kalendertage vor dem Beginn
export const ANMELDEFENSTER_STANDARD = 42;

// Der Schweizer Kalendertag, ab dem sich anmelden lässt (yyyy-mm-dd); die Zahl kommt als Parameter, nie aus der Anfrage
export const anmeldungAb = (tage: number): SQL<string> =>
  sql`((${programmBeginn} at time zone 'Europe/Zurich')::date - ${tage}::int)`;

// Das Fenster ist offen, sobald der Tag erreicht ist; die Uhr der Datenbank entscheidet, ausser der Aufrufer gibt `jetzt` vor (der Zeitregel-Prüfer rechnet mit seinem eigenen Zeitpunkt)
export const fensterOffen = (tage: number, jetzt?: Date): SQL<boolean> =>
  sql`(${anmeldungAb(tage)} <= (${jetzt ? sql`${jetzt.toISOString()}::timestamptz` : sql`now()`} at time zone 'Europe/Zurich')::date)`;

// Nur Termine einer Art, die die Einheit freigegeben hat, haben eine Anmeldung. Ohne Art oder ohne Entscheid der Einheit (null) gibt es keine; die Bedingung gehört überall dazu, wo eine Anmeldung entsteht, zählt oder erinnert wird
export const anmeldbar: SQL<boolean> = sql`exists (select 1 from einheit ae where ae.id = programm.einheit_id and programm.art = any(ae.anmelde_arten))`;

// Die App sieht nur Termine der Arten, die die Einheit gewählt hat; ohne Auswahl (null oder leer) sieht sie alle. Gilt für Liste und Detail der App, nicht für Verwaltung, Push oder Erinnerungen
export const artSichtbar: SQL<boolean> = sql`exists (select 1 from einheit se where se.id = programm.einheit_id and (coalesce(cardinality(se.anmelde_arten), 0) = 0 or programm.art = any(se.anmelde_arten)))`;

// Aktiv, nicht begonnen, im Fenster und anmeldbar: nur dann lässt sich antworten
export const antwortOffen = (tage: number): SQL<boolean> =>
  sql`(programm.status = 'aktiv' and ${programmBeginn} > now() and ${fensterOffen(tage)} and ${anmeldbar})`;

// «23.01.2027» für die Meldung bei 409
export const schweizerDatum = (tag: string) =>
  tag.split("-").reverse().join(".");
