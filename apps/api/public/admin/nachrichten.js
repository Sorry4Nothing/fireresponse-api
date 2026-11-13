import { anfrage, fehlertext } from "./api.js";
import {
  bestaetigen,
  chip,
  dialogFormular,
  el,
  feld,
  knopf,
  seitenblatt,
  zeit,
} from "./dom.js";
import { istKantonsadmin } from "./kontext.js";

// Die Glocke der Verwaltung: Der Kantonsadmin schreibt wichtige Hinweise an die Konten der Verwaltung (Kommando, Stellvertretungen); sie erscheinen hier und nie in der App. Das Panel zeigt nur, die API prüft die Rechte.

const PFAD = "/api/v1/admin/nachrichten";
// So oft fragt die Glocke nach, solange die Seite offen ist (und sofort, wenn der Tab wieder sichtbar wird)
const TAKT_MS = 5 * 60 * 1000;

// Wert für ein datetime-local-Feld ist Ortszeit; die API bekommt ISO mit Zone
const ausLokal = (wert) => (wert ? new Date(wert).toISOString() : null);

// Beschriftung des Knopfs: Der Zähler steht als Text da, nie nur als Farbe oder Punkt
function knopfName(daten) {
  if (!daten) return "Nachrichten";
  if (istKantonsadmin()) return "Nachrichten";
  const n = daten.nachrichten.filter((m) => !m.gelesen).length;
  return n === 0
    ? "Nachrichten, keine ungelesen"
    : `Nachrichten, ${n} ungelesen`;
}

// Die Glocke im Dock; liefert { wurzel }. melde zeigt Rückmeldungen der Seite
export function erstelleGlocke({ melde }) {
  let daten = null;
  const glocke = knopf("", {
    klein: true,
    symbol: "glocke",
    "aria-haspopup": "dialog",
    "aria-label": "Nachrichten",
    onclick: oeffne,
  });
  const zahl = el("span", { class: "glocke-zahl" });
  glocke.append(zahl);

  function zeichneKnopf() {
    const n = daten ? daten.nachrichten.filter((m) => !m.gelesen).length : 0;
    // Der Kantonsadmin ist kein Empfänger: kein Zähler
    zahl.textContent = istKantonsadmin() || n === 0 ? "" : String(n);
    glocke.setAttribute("aria-label", knopfName(daten));
  }

  async function lade() {
    daten = await anfrage("GET", PFAD);
    zeichneKnopf();
    return daten;
  }

  // Ein Fehler beim stillen Nachfragen lässt den alten Stand stehen
  const auffrischen = () => lade().catch(() => {});
  auffrischen();
  const takt = setInterval(() => {
    if (!glocke.isConnected) return clearInterval(takt);
    auffrischen();
  }, TAKT_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && glocke.isConnected) {
      auffrischen();
    }
  });

  async function oeffne() {
    try {
      await lade();
    } catch (f) {
      melde(fehlertext(f), "fehler");
      return;
    }
    const liste = el("div", { class: "nachrichten" });
    // Rückmeldungen im Blatt selbst: Die Live-Region der Seite liegt hinter dem Dialog und bleibt stumm
    const status = el("p", { class: "meta", role: "status" });
    const sag = (text, art = "ok") => {
      status.textContent = "";
      status.className = text ? `hinweis hinweis--${art}` : "meta";
      setTimeout(() => (status.textContent = text), 50);
    };
    const fuss = el("div", { class: "aktionen" });
    const blatt = seitenblatt({
      titel: "Nachrichten",
      untertitel: istKantonsadmin()
        ? "Wichtige Hinweise an Kommando und Stellvertretungen. Du siehst nur, wie viele sie gelesen haben."
        : "Wichtige Hinweise der Kantonsadministration.",
      inhalt: [status, liste],
      fusszeile: fuss,
      schliessen: zeichneKnopf,
    });

    // fokusId: Die Nachricht, deren Knopf eben gedrückt wurde; ihre Überschrift bekommt den Fokus, weil der Knopf mit dem Neuzeichnen verschwindet
    function zeichne(fokusId) {
      const eintraege = daten.nachrichten;
      liste.replaceChildren(
        eintraege.length === 0
          ? el("p", { class: "leer leer--klein" }, "Keine Nachrichten.")
          : el(
              "ul",
              { class: "nachrichten-liste" },
              eintraege.map((m) => nachrichtZeile(m)),
            ),
      );
      zeichneFuss();
      zeichneKnopf();
      if (fokusId) {
        liste.querySelector(`[data-id="${fokusId}"] h3`)?.focus();
      }
    }

    async function neuLaden(fokusId) {
      try {
        await lade();
      } catch (f) {
        sag(fehlertext(f), "fehler");
        return;
      }
      zeichne(fokusId);
    }

    function nachrichtZeile(m) {
      const admin = istKantonsadmin();
      return el(
        "li",
        { class: "nachricht", "data-id": m.id },
        el("h3", { tabindex: "-1" }, m.titel),
        el(
          "ul",
          { class: "chips" },
          admin
            ? [
                m.abgelaufen && chip("Abgelaufen", "warn"),
                chip(
                  `${m.lesende} von ${daten.empfaenger} gelesen`,
                  undefined,
                  false,
                ),
              ]
            : m.gelesen
              ? chip("Gelesen", "ok")
              : chip("Ungelesen", undefined, "glocke"),
        ),
        el(
          "p",
          { class: "meta" },
          `Gesendet ${zeit(m.erstelltAm)}`,
          m.laeuftAbAm &&
            ` · ${m.abgelaufen ? "abgelaufen" : "bis"} ${zeit(m.laeuftAbAm)}`,
        ),
        el("p", { class: "nachricht-text" }, m.text),
        el(
          "div",
          { class: "aktionen" },
          admin
            ? knopf("Zurückziehen", {
                klein: true,
                symbol: "papierkorb",
                kontext: m.titel,
                onclick: () => zurueckziehen(m),
              })
            : !m.gelesen &&
                knopf("Als gelesen markieren", {
                  klein: true,
                  symbol: "haken",
                  kontext: m.titel,
                  onclick: async () => {
                    try {
                      await anfrage("PUT", `${PFAD}/${m.id}/gelesen`);
                    } catch (f) {
                      sag(fehlertext(f), "fehler");
                    }
                    neuLaden(m.id);
                  },
                }),
        ),
      );
    }

    function zeichneFuss() {
      if (istKantonsadmin()) {
        fuss.replaceChildren(
          knopf("Nachricht senden", {
            art: "haupt",
            symbol: "plus",
            onclick: senden,
          }),
        );
        return;
      }
      const ungelesen = daten.nachrichten.some((m) => !m.gelesen);
      fuss.replaceChildren(
        knopf("Alle als gelesen markieren", {
          art: "haupt",
          symbol: "haken",
          disabled: !ungelesen,
          onclick: async () => {
            try {
              await anfrage("POST", `${PFAD}/gelesen`);
            } catch (f) {
              sag(fehlertext(f), "fehler");
            }
            await neuLaden();
            blatt.querySelector("h2")?.focus();
          },
        }),
      );
    }

    function senden() {
      const titel = feld({
        label: "Titel",
        maxlength: 80,
        required: true,
        autocomplete: "off",
        hilfe: "Höchstens 80 Zeichen.",
      });
      const text = feld({
        label: "Text",
        mehrzeilig: true,
        rows: 6,
        maxlength: 1000,
        required: true,
        hilfe:
          "Höchstens 1000 Zeichen, nur Text. Keine Namen und keine Personendaten schreiben.",
      });
      const ende = feld({
        label: "Anzeigen bis (optional)",
        typ: "datetime-local",
        hilfe:
          "Danach verschwindet die Nachricht aus der Glocke. Ohne Angabe bleibt sie stehen.",
      });
      dialogFormular({
        titel: "Nachricht senden",
        beschreibung:
          "Die Nachricht geht an alle Konten der Verwaltung (Kommando und Stellvertretungen) und erscheint nur in deren Glocke, nicht in der App und nicht als Push. Du kannst sie später zurückziehen.",
        felder: [titel.wurzel, text.wurzel, ende.wurzel],
        ok: "Senden",
        senden: () =>
          anfrage("POST", PFAD, {
            titel: titel.eingabe.value.trim(),
            text: text.eingabe.value.trim(),
            laeuftAbAm: ausLokal(ende.eingabe.value),
          }),
        danach: (neu) => {
          sag("Nachricht gesendet.");
          neuLaden(neu?.id);
        },
      });
    }

    function zurueckziehen(m) {
      bestaetigen({
        titel: "Nachricht zurückziehen",
        beschreibung: `«${m.titel}» verschwindet bei allen Konten der Verwaltung. Das lässt sich nicht rückgängig machen.`,
        ok: "Zurückziehen",
        aktion: () => anfrage("DELETE", `${PFAD}/${m.id}`),
        danach: async () => {
          sag("Nachricht zurückgezogen.");
          await neuLaden();
          blatt.querySelector("h2")?.focus();
        },
      });
    }

    zeichne();
  }

  return { wurzel: glocke };
}
