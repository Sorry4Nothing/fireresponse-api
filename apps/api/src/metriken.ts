// Betriebszahlen der API im Arbeitsspeicher, für die Übersicht der Verwaltung (#143).
// Erfasst werden nur Methode, Routenmuster (nie der Pfad), Statuscode und Dauer: keine Query, kein Body, keine Header, keine IP, keine Personen.
// Der Speicher ist begrenzt: 24 Stunden in Minuten-Eimern, höchstens MAX_ROUTEN Muster, die letzten MAX_FEHLER Fehler. Nach einem Neustart ist alles leer.

const MINUTE = 60_000;
export const MINUTEN = 24 * 60;
export const MAX_ROUTEN = 200;
export const MAX_FEHLER = 30;
// Obere Grenzen der Dauerklassen in ms; darüber liegt die letzte Klasse
export const GRENZEN_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

type Eimer = { minute: number; k: number[]; h: number[] };
type Route = { anzahl: number; k4: number; k5: number; h: number[] };

const leereKlassen = () => new Array<number>(GRENZEN_MS.length + 1).fill(0);
const klasse = (ms: number) => {
  const i = GRENZEN_MS.findIndex((grenze) => ms <= grenze);
  return i === -1 ? GRENZEN_MS.length : i;
};

// Obere Grenze der Klasse, in der das Quantil liegt; die letzte Klasse meldet ihre Untergrenze
function quantil(h: readonly number[], q: number) {
  const summe = h.reduce((a, b) => a + b, 0);
  if (summe === 0) return null;
  let bis = 0;
  for (let i = 0; i < h.length; i++) {
    bis += h[i];
    if (bis >= q * summe) return GRENZEN_MS[Math.min(i, GRENZEN_MS.length - 1)];
  }
  return GRENZEN_MS.at(-1)!;
}

export function erstelleMetriken(jetzt: () => number = () => Date.now()) {
  const start = jetzt();
  const eimer: Eimer[] = Array.from({ length: MINUTEN }, () => ({
    minute: -1,
    k: [0, 0, 0, 0, 0],
    h: leereKlassen(),
  }));
  const routen = new Map<string, Route>();
  const fehler: {
    zeit: string;
    methode: string;
    route: string;
    status: number;
  }[] = [];

  // Pro Minute genau ein Eimer: Ist der Platz noch von gestern, wird er geleert
  function eimerFuer(minute: number) {
    const e = eimer[minute % MINUTEN];
    if (e.minute !== minute) {
      e.minute = minute;
      e.k.fill(0);
      e.h.fill(0);
    }
    return e;
  }

  function erfasse(r: {
    methode: string;
    route: string;
    status: number;
    dauerMs: number;
  }) {
    const ms = jetzt();
    const e = eimerFuer(Math.floor(ms / MINUTE));
    const art = Math.min(Math.max(Math.floor(r.status / 100), 1), 5) - 1;
    e.k[art]++;
    const k = klasse(r.dauerMs);
    e.h[k]++;

    let schluessel = `${r.methode} ${r.route}`;
    if (!routen.has(schluessel) && routen.size >= MAX_ROUTEN) {
      schluessel = "andere";
    }
    let z = routen.get(schluessel);
    if (!z) {
      z = { anzahl: 0, k4: 0, k5: 0, h: leereKlassen() };
      routen.set(schluessel, z);
    }
    z.anzahl++;
    if (r.status >= 500) z.k5++;
    else if (r.status >= 400) z.k4++;
    z.h[k]++;

    if (r.status >= 400) {
      fehler.push({
        zeit: new Date(ms).toISOString(),
        methode: r.methode,
        route: r.route,
        status: r.status,
      });
      if (fehler.length > MAX_FEHLER) fehler.shift();
    }
  }

  // Alle Eimer der letzten n Minuten, ältester zuerst; fehlende Minuten sind leer
  function fenster(n: number, ende = Math.floor(jetzt() / MINUTE)) {
    return Array.from({ length: n }, (_, i) => {
      const minute = ende - n + 1 + i;
      const e = eimer[((minute % MINUTEN) + MINUTEN) % MINUTEN];
      return e.minute === minute ? e : null;
    });
  }

  function summiere(teile: (Eimer | null)[]) {
    const k = [0, 0, 0, 0, 0];
    const h = leereKlassen();
    for (const e of teile) {
      if (!e) continue;
      e.k.forEach((wert, i) => (k[i] += wert));
      e.h.forEach((wert, i) => (h[i] += wert));
    }
    return { k, h };
  }

  function momentaufnahme() {
    const jetztMinute = Math.floor(jetzt() / MINUTE);
    const alle = summiere(fenster(MINUTEN));
    const punkt = (teile: (Eimer | null)[], minute: number) => {
      const s = summiere(teile);
      return {
        ab: new Date(minute * MINUTE).toISOString(),
        anzahl: s.k.reduce((a, b) => a + b, 0),
        fehler4xx: s.k[3],
        fehler5xx: s.k[4],
      };
    };
    const stunden = Array.from({ length: 24 }, (_, i) => {
      const ende = jetztMinute - (23 - i) * 60;
      return punkt(fenster(60, ende), ende - 59);
    });
    const minuten = Array.from({ length: 60 }, (_, i) => {
      const minute = jetztMinute - 59 + i;
      return punkt(fenster(1, minute), minute);
    });
    const gesamt = alle.k.reduce((a, b) => a + b, 0);
    return {
      seit: new Date(start).toISOString(),
      gesamt,
      letzteMinute: minuten.at(-1)!.anzahl,
      letzteStunde: stunden.at(-1)!.anzahl,
      statusklassen: {
        "1xx": alle.k[0],
        "2xx": alle.k[1],
        "3xx": alle.k[2],
        "4xx": alle.k[3],
        "5xx": alle.k[4],
      },
      // Anteil der Antworten mit 5xx bzw. 4xx an allen
      quote5xx: gesamt === 0 ? 0 : alle.k[4] / gesamt,
      quote4xx: gesamt === 0 ? 0 : alle.k[3] / gesamt,
      p50Ms: quantil(alle.h, 0.5),
      p95Ms: quantil(alle.h, 0.95),
      stunden,
      minuten,
      routen: [...routen]
        .map(([schluessel, z]) => {
          const leer = schluessel === "andere";
          const [methode, ...rest] = leer
            ? ["", "andere"]
            : schluessel.split(" ");
          return {
            methode,
            route: rest.join(" "),
            anzahl: z.anzahl,
            fehler4xx: z.k4,
            fehler5xx: z.k5,
            p50Ms: quantil(z.h, 0.5),
            p95Ms: quantil(z.h, 0.95),
          };
        })
        .sort((a, b) => b.anzahl - a.anzahl),
      letzteFehler: [...fehler].reverse(),
    };
  }

  return { erfasse, momentaufnahme };
}

export type Metriken = ReturnType<typeof erstelleMetriken>;
