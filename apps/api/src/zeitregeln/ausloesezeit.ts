const TAG_MS = 86_400_000;
const WOCHENTAG = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

const zuerich = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Zurich",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

// Abstand der Zürcher Wanduhr zu UTC in ms zum Zeitpunkt t (Sommerzeit inbegriffen), nie über die Zone des Servers
function versatz(t: number) {
  const teile = Object.fromEntries(
    zuerich.formatToParts(t).map((p) => [p.type, Number(p.value)]),
  );
  const wand = Date.UTC(
    teile.year!,
    teile.month! - 1,
    teile.day!,
    teile.hour!,
    teile.minute!,
    teile.second!,
  );
  return wand - Math.floor(t / 1000) * 1000;
}

// Die Zürcher Wanduhr eines Zeitpunkts, als UTC-Datum verpackt: Tage zählen und Wochentage lesen geht dann ohne Sommerzeit-Sprünge
export const wanduhr = (t: Date) =>
  new Date(t.getTime() + versatz(t.getTime()));

// Wochentag nach ISO: 1 Montag bis 7 Sonntag
const isoWochentag = (d: Date) => d.getUTCDay() || 7;

// «Sa 31.10.» für den Tag, an dem das Programm in Zürich beginnt
export function kurzDatum(beginn: Date) {
  const w = wanduhr(beginn);
  return `${WOCHENTAG[w.getUTCDay()]} ${w.getUTCDate()}.${w.getUTCMonth() + 1}.`;
}

// Der letzte Zeitpunkt (Zürcher Zeit) mit diesem Wochentag und dieser Uhrzeit, der nicht nach dem Beginn liegt
// shortcut: Eine Uhrzeit in der übersprungenen Stunde der Umstellung (02:xx im Frühling) rückt auf 03:xx; in der doppelten Stunde (Herbst) gilt die zweite. Genauer nur, falls eine Abteilung genau dort Regeln will
export function ausloesezeit(
  beginn: Date,
  wochentag: number,
  uhrzeit: string,
): Date {
  const [h, m] = uhrzeit.split(":").map(Number) as [number, number];
  const beginnWand = wanduhr(beginn);
  let wand = Date.UTC(
    beginnWand.getUTCFullYear(),
    beginnWand.getUTCMonth(),
    beginnWand.getUTCDate(),
    h,
    m,
  );
  if (wand > beginnWand.getTime()) wand -= TAG_MS;
  while (isoWochentag(new Date(wand)) !== wochentag) wand -= TAG_MS;
  // Von der Wanduhr zurück zum Zeitpunkt: erst mit dem Versatz an der Wanduhr geraten, dann mit dem Versatz am Ergebnis nachgerechnet
  const geraten = wand - versatz(wand);
  return new Date(wand - versatz(geraten));
}
