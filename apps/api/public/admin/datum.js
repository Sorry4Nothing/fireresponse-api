// Datumslogik für den Datepicker (datumfeld.js), ohne Seite und ohne Importe, damit sie sich testen lässt.
// Ein Datum ist immer ein Text «yyyy-mm-dd» (wie das Feld type="date" und die API); gerechnet wird in UTC, damit keine Sommerzeit dazwischenfunkt. Monate zählen hier von 1 bis 12.

export const MONATE = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];
// Montag zuerst; [Kürzel, Name]
export const WOCHENTAGE = [
  ["Mo", "Montag"],
  ["Di", "Dienstag"],
  ["Mi", "Mittwoch"],
  ["Do", "Donnerstag"],
  ["Fr", "Freitag"],
  ["Sa", "Samstag"],
  ["So", "Sonntag"],
];

const zwei = (n) => String(n).padStart(2, "0");

// setUTCFullYear statt Date.UTC: Jahre unter 100 blieben dort im 20. Jahrhundert
function utc(jahr, monat, tag) {
  const d = new Date(0);
  d.setUTCFullYear(jahr, monat - 1, tag);
  return d;
}

function aus(d) {
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${zwei(d.getUTCMonth() + 1)}-${zwei(d.getUTCDate())}`;
}

// [Jahr, Monat, Tag] eines gültigen Datums, sonst null; 30. Februar oder Jahr vor 1000 sind ungültig
export function teile(iso) {
  const treffer = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!treffer) return null;
  const [j, m, t] = treffer.slice(1).map(Number);
  if (j < 1000 || m < 1 || m > 12 || t < 1) return null;
  return t <= tageImMonat(j, m) ? [j, m, t] : null;
}

export function tageImMonat(jahr, monat) {
  return utc(jahr, monat + 1, 0).getUTCDate();
}

// «5.3.2026» oder «05.03.2026» → «2026-03-05»; sonst null
export function parseDe(text) {
  const treffer = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/.exec(text ?? "");
  if (!treffer) return null;
  const [t, m, j] = treffer.slice(1).map(Number);
  const iso = `${String(j).padStart(4, "0")}-${zwei(m)}-${zwei(t)}`;
  return teile(iso) ? iso : null;
}

// «2026-03-05» → «05.03.2026»; ungültig → ""
export function formatDe(iso) {
  const teil = teile(iso);
  return teil ? `${zwei(teil[2])}.${zwei(teil[1])}.${teil[0]}` : "";
}

// «5. März 2026, Donnerstag»: Name der Tageszelle für Screenreader; beginnt mit dem sichtbaren Tag
export function langDe(iso) {
  const [j, m, t] = teile(iso);
  return `${t}. ${MONATE[m - 1]} ${j}, ${WOCHENTAGE[wochentag(iso)][1]}`;
}

// 0 Montag bis 6 Sonntag
export function wochentag(iso) {
  const [j, m, t] = teile(iso);
  return (utc(j, m, t).getUTCDay() + 6) % 7;
}

// Heute in der Zeitzone des Geräts (nicht in UTC: nach Mitternacht Schweizer Zeit ist UTC noch gestern)
export function heute(jetzt = new Date()) {
  return `${String(jetzt.getFullYear()).padStart(4, "0")}-${zwei(jetzt.getMonth() + 1)}-${zwei(jetzt.getDate())}`;
}

// Verschiebt um Tage, Monate und Jahre; der Tag bleibt im Zielmonat (31. Januar + 1 Monat = 28. oder 29. Februar)
export function verschiebe(iso, { tage = 0, monate = 0, jahre = 0 } = {}) {
  const [j, m, t] = teile(iso);
  const index = j * 12 + (m - 1) + monate + jahre * 12;
  const jahrNeu = Math.floor(index / 12);
  const monatNeu = (index % 12) + 1;
  const d = utc(jahrNeu, monatNeu, Math.min(t, tageImMonat(jahrNeu, monatNeu)));
  d.setUTCDate(d.getUTCDate() + tage);
  return aus(d);
}

// Liegt iso zwischen min und max? Fehlende Grenzen (leer) gelten nicht; der Textvergleich stimmt bei «yyyy-mm-dd»
export function imBereich(iso, min, max) {
  return (!min || iso >= min) && (!max || iso <= max);
}

export function begrenze(iso, min, max) {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

// Gibt es im Monat mindestens einen erlaubten Tag?
export function monatErlaubt(jahr, monat, min, max) {
  const erster = `${String(jahr).padStart(4, "0")}-${zwei(monat)}-01`;
  const letzter = `${String(jahr).padStart(4, "0")}-${zwei(monat)}-${zwei(tageImMonat(jahr, monat))}`;
  return imBereich(erster, "", max) && imBereich(letzter, min, "");
}

// Sechs Wochen zu je sieben Tagen, Montag zuerst; die Höhe bleibt so von Monat zu Monat gleich
// Jede Zelle: { iso, imMonat }
export function monatsraster(jahr, monat) {
  const erster = `${String(jahr).padStart(4, "0")}-${zwei(monat)}-01`;
  const start = verschiebe(erster, { tage: -wochentag(erster) });
  return Array.from({ length: 6 }, (_, woche) =>
    Array.from({ length: 7 }, (_, tag) => {
      const iso = verschiebe(start, { tage: woche * 7 + tag });
      return { iso, imMonat: Number(iso.slice(5, 7)) === monat };
    }),
  );
}
