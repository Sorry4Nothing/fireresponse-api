import { anfrage, fehlertext } from "./api.js";
import { chip, el, icon, knopf, neueId, tabelle, zeit } from "./dom.js";
import { syncChips } from "./einheiten.js";
import { TYPNAME } from "./kontext.js";

// System: Protokoll der Änderungen (wer hat wann was getan) und Stand des Syncs je Einheit. Beides nur zum Lesen. Das Protokoll enthält IDs und feste Aktionsnamen, nie Namen oder Eingaben.

const AKTIONEN = {
  bezirk_angelegt: "Bezirk angelegt",
  bezirk_umbenannt: "Bezirk umbenannt",
  bezirk_geloescht: "Bezirk gelöscht",
  einheit_angelegt: "Einheit angelegt",
  einheit_geloescht: "Einheit gelöscht",
  kommando_uebergeben: "Kommando übergeben",
  person_angelegt: "Konto angelegt",
  person_zugewiesen: "Konto einer weiteren Einheit zugewiesen",
  person_geaendert: "Konto geändert",
  startpasswort_neu: "Neues Startpasswort",
  startpasswort_angezeigt: "Startpasswort angezeigt",
  person_deaktiviert: "Konto deaktiviert",
  person_aktiviert: "Konto aktiviert",
  zweiter_faktor_zurueckgesetzt: "Zweiter Faktor zurückgesetzt",
  rolle_geaendert: "Rolle geändert",
  leitung_entfernt: "Leitung entfernt",
  stellvertretung_geordnet: "Stellvertretungen geordnet",
  stellvertretung_entfernt: "Stellvertretung entfernt",
  teilnehmende_angelegt: "Person angelegt",
  teilnehmende_geaendert: "Person geändert",
  eltern_verknuepft: "Eltern verknüpft",
  konto_gewechselt: "Konto aufs Kind übertragen",
  rang_angelegt: "Rang angelegt",
  rang_geaendert: "Rang geändert",
  rang_geloescht: "Rang gelöscht",
  raenge_geordnet: "Ränge geordnet",
  rang_abzeichen_gesetzt: "Abzeichen gesetzt",
  rang_abzeichen_entfernt: "Abzeichen entfernt",
  einheit_logo_gesetzt: "Logo gesetzt",
  einheit_logo_entfernt: "Logo entfernt",
  zeitregel_angelegt: "Erinnerung angelegt",
  zeitregel_geaendert: "Erinnerung geändert",
  zeitregel_geloescht: "Erinnerung gelöscht",
};

// «rolle: leitung, felder: name, telefon»; die Werte sind feste Wörter, IDs und Zahlen
function detailText(details) {
  if (!details || typeof details !== "object") return "";
  return Object.entries(details)
    .map(([schluessel, wert]) => {
      const text = Array.isArray(wert)
        ? wert.join(", ")
        : typeof wert === "object" && wert !== null
          ? JSON.stringify(wert)
          : String(wert);
      return `${schluessel}: ${text}`;
    })
    .join(" · ");
}

export function aenderungenTafel() {
  const eintraege = [];
  let weiter = null;
  let suche = "";
  const status = el("p", { class: "klein leise", role: "status" });
  const liste = el("div", {});
  const mehr = el("div", { class: "aktionen aktionen--unten" });
  const fehler = el("p", {
    class: "hinweis hinweis--fehler",
    role: "alert",
    hidden: true,
  });
  const sucheId = neueId("suche");
  const sucheFeld = el("input", {
    id: sucheId,
    class: "eingabe",
    type: "search",
    placeholder: "Aktion, Person oder Einheit",
    autocomplete: "off",
  });

  function zeichne() {
    const frage = suche.trim().toLowerCase();
    const treffer = eintraege.filter((e) =>
      [
        AKTIONEN[e.aktion] ?? e.aktion,
        e.akteur.name ?? "",
        e.einheit?.name ?? "",
        e.einheit?.bezirk ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(frage),
    );
    status.textContent =
      treffer.length === eintraege.length
        ? `${eintraege.length} Einträge geladen`
        : `${treffer.length} von ${eintraege.length} geladenen Einträgen`;
    if (treffer.length === 0) {
      liste.replaceChildren(
        el(
          "p",
          { class: "leer leer--klein" },
          eintraege.length === 0
            ? "Noch keine Änderungen."
            : "Kein Eintrag passt zur Suche.",
        ),
      );
    } else {
      liste.replaceChildren(
        tabelle({
          beschriftung: "Änderungen",
          spalten: ["Zeit", "Aktion", "Wer", "Einheit", "Einzelheiten"],
          zeilen: treffer.map((e) =>
            el(
              "tr",
              {},
              el("td", {}, zeit(e.zeit)),
              el("th", { scope: "row" }, AKTIONEN[e.aktion] ?? e.aktion),
              el(
                "td",
                {},
                e.akteur.cli
                  ? chip("Kommandozeile")
                  : (e.akteur.name ??
                      el("span", { class: "leise" }, "Konto gelöscht")),
              ),
              el(
                "td",
                {},
                e.einheit
                  ? `${e.einheit.name} (${e.einheit.bezirk})`
                  : el("span", { class: "leise" }, "–"),
              ),
              el("td", { class: "mono" }, detailText(e.details)),
            ),
          ),
        }).wurzel,
      );
    }
    mehr.replaceChildren(
      ...(weiter
        ? [
            knopf("Ältere laden", {
              symbol: "runter",
              onclick: () => lade(true),
            }),
          ]
        : []),
    );
  }

  async function lade(anhaengen = false) {
    fehler.hidden = true;
    try {
      const q = new URLSearchParams({ limit: "50" });
      if (anhaengen && weiter) q.set("vor", weiter);
      const antwort = await anfrage("GET", `/api/v1/admin/system/changes?${q}`);
      if (!anhaengen) eintraege.length = 0;
      eintraege.push(...antwort.eintraege);
      weiter = antwort.weiter;
      zeichne();
    } catch (f) {
      fehler.textContent = fehlertext(f);
      fehler.hidden = false;
    }
  }

  sucheFeld.addEventListener("input", () => {
    suche = sucheFeld.value;
    zeichne();
  });
  lade();
  return [
    fehler,
    el(
      "div",
      { class: "werkzeuge" },
      el(
        "div",
        { class: "suche" },
        el("label", { class: "nur-leser", for: sucheId }, "Änderungen suchen"),
        icon("lupe"),
        sucheFeld,
      ),
      knopf("Aktualisieren", {
        symbol: "aktualisieren",
        onclick: () => lade(false),
      }),
    ),
    status,
    liste,
    mehr,
  ];
}

// Stand des Syncs je Einheit; die Zahlen kommen aus den Spalten der Einheit
export function syncTafel() {
  const inhalt = el("div", {});
  const fehler = el("p", {
    class: "hinweis hinweis--fehler",
    role: "alert",
    hidden: true,
  });
  async function lade() {
    fehler.hidden = true;
    try {
      const { einheiten } = await anfrage("GET", "/api/v1/admin/system/sync");
      inhalt.replaceChildren(
        einheiten.length === 0
          ? el(
              "p",
              { class: "leer leer--klein" },
              "Es gibt noch keine Einheit.",
            )
          : tabelle({
              beschriftung: "Sync-Stand je Einheit",
              spalten: ["Einheit", "Art", "Bezirk", "Stand"],
              zeilen: einheiten.map((e) =>
                el(
                  "tr",
                  {},
                  el("th", { scope: "row" }, e.name),
                  el("td", {}, TYPNAME[e.typ]),
                  el("td", {}, e.bezirk),
                  el("td", {}, el("ul", { class: "chips" }, syncChips(e))),
                ),
              ),
            }).wurzel,
      );
    } catch (f) {
      fehler.textContent = fehlertext(f);
      fehler.hidden = false;
    }
  }
  lade();
  return [
    fehler,
    el(
      "p",
      { class: "hilfe" },
      "Nur Anzeige: Der Sync läuft von selbst alle 15 Minuten, einen manuellen Sync gibt es nicht. Ein Fehler zeigt nur einen Code, nie den Link.",
    ),
    el(
      "div",
      { class: "aktionen" },
      knopf("Aktualisieren", { symbol: "aktualisieren", onclick: lade }),
    ),
    inhalt,
  ];
}
