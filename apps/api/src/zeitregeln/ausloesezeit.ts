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

// «Sa 31.10.» für den Tag, an dem das Programm in Zürich beginnt
export function kurzDatum(beginn: Date) {
  const w = wanduhr(beginn);
  return `${WOCHENTAG[w.getUTCDay()]} ${w.getUTCDate()}.${w.getUTCMonth() + 1}.`;
}

// Der Zeitpunkt `tageVorher` Kalendertage vor dem Tag des Beginns (Zürcher Zeit) zur Uhrzeit; er kann nach dem Beginn liegen (0 Tage, Uhrzeit nach dem Beginn), dann ist die Regel für dieses Programm sinnlos
// shortcut: Eine Uhrzeit in der übersprungenen Stunde der Umstellung (02:xx im Frühling) rückt auf 03:xx; in der doppelten Stunde (Herbst) gilt die zweite. Genauer nur, falls eine Einheit genau dort Regeln will
export function ausloesezeit(
  beginn: Date,
  tageVorher: number,
  uhrzeit: string,
): Date {
  const [h, m] = uhrzeit.split(":").map(Number) as [number, number];
  const w = wanduhr(beginn);
  // Date.UTC rechnet den Tagesüberlauf (Monat, Jahr) selbst
  return vonWanduhr(
    Date.UTC(
      w.getUTCFullYear(),
      w.getUTCMonth(),
      w.getUTCDate() - tageVorher,
      h,
      m,
    ),
  );
}

// Von der Zürcher Wanduhr (als UTC-Millisekunden verpackt) zurück zum Zeitpunkt: erst mit dem Versatz an der Wanduhr geraten, dann mit dem Versatz am Ergebnis nachgerechnet
export function vonWanduhr(wand: number) {
  const geraten = wand - versatz(wand);
  return new Date(wand - versatz(geraten));
}
