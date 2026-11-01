import { el } from "./dom.js";
import {
  diagramm,
  fehlerTabelle,
  hinweisSeitStart,
  kachel,
  ladeBetrieb,
  laufend,
  ms,
  panel,
  stundenName,
  zahl,
} from "./system.js";

export function zeige(bereich, ctx) {
  ctx.lade(ladeBetrieb, (daten) => zeichneSeite(bereich, daten));
}

// Eine Zeile zur Lage; der Zustand steht im Wort, die Farbe und das Symbol (aus dem CSS) verstärken nur
function lage(s) {
  const probleme = [];
  if (!s.datenbank.erreichbar) {
    probleme.push(["fehler", "Die Datenbank ist nicht erreichbar."]);
  }
  if (probleme.length === 0) return ["ok", "Alles in Ordnung."];
  const art = probleme.some(([a]) => a === "fehler") ? "fehler" : "warn";
  return [art, probleme.map(([, text]) => text).join(" ")];
}

function zeichneSeite(bereich, daten) {
  const offen = { wert: false };
  const fehlerFeld = el("p", { class: "meta fehlerzeile", role: "status" });
  const stand = el("p", { class: "meta stand" });
  const hinweis = el("p", { class: "hinweis" });
  const kacheln = el("div", { class: "kacheln" });
  const verlauf = el("div", {});
  const fehler = el("div", {});
  const summe = el("p", { class: "meta" });

  function zeichne({ system: s, anfragen: a }) {
    stand.textContent = `Stand ${new Date().toLocaleTimeString("de-CH")}, wird alle 15 Sekunden aktualisiert.`;
    const b = s.bestand;
    const [art, text] = lage(s);
    hinweis.className = `hinweis hinweis--${art}`;
    hinweis.textContent = text;
    kacheln.replaceChildren(
      kachel({ titel: "Aktive Personen", wert: zahl(b.aktivePersonen) }),
      kachel({ titel: "Aktive Kinder", wert: zahl(b.aktiveKinder) }),
      kachel({ titel: "Push-Tokens", wert: zahl(b.pushTokens) }),
      kachel({
        titel: "Datenbank",
        wert: s.datenbank.erreichbar ? "Erreichbar" : "Nicht erreichbar",
        text: true,
        status: s.datenbank.erreichbar ? "ok" : "fehler",
        hinweis:
          s.datenbank.pingMs === null
            ? undefined
            : `Antwortzeit ${ms(s.datenbank.pingMs)}`,
      }),
    );
    verlauf.replaceChildren(
      diagramm({
        titel: "Anfragen pro Stunde, letzte 24 Stunden",
        punkte: a.stunden,
        beschriftung: stundenName,
        einheit: "Stunde",
        offen,
      }),
    );
    summe.textContent = [
      `${zahl(a.gesamt)} Anfragen`,
      `Fehlerquote 5xx ${(a.quote5xx * 100).toFixed(1)} %`,
      `Dauer p95 ${ms(a.p95Ms)}`,
    ].join(" · ");
    fehler.replaceChildren(fehlerTabelle(a.letzteFehler, 8));
  }

  zeichne(daten);
  bereich.append(
    hinweis,
    el("div", { class: "stand-zeile" }, stand, fehlerFeld),
    kacheln,
    el(
      "div",
      { class: "raster raster--3" },
      panel("Anfragen der letzten 24 Stunden", summe, verlauf),
      panel("Letzte Fehler", fehler),
    ),
    el("p", { class: "hilfe" }, hinweisSeitStart(daten.anfragen)),
  );
  laufend(bereich, ladeBetrieb, zeichne, fehlerFeld);
}
