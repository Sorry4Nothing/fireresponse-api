import { anfrage } from "./api.js";
import { el, icon, neueId, seitenblatt } from "./dom.js";

// Wer angemeldet ist und welche Einheit die Verwaltung gerade zeigt. Die Wahl der Einheit steht nur in dieser Sitzung des Browsers (sessionStorage, nur die ID); Rechte prüft immer die API.

const SCHLUESSEL = "verwaltung-einheit";

export const kontext = {
  // Antwort von GET /api/v1/ich
  profil: null,
  // Antwort von GET /api/v1/admin/einheiten
  einheiten: [],
  aktiveId: null,
};

export const istKantonsadmin = () => kontext.profil?.kantonsadmin === true;

export function aktiveEinheit() {
  return kontext.einheiten.find((e) => e.id === kontext.aktiveId) ?? null;
}

// Wer eine Verwaltungsrolle hat: Kantonsadmin, Kommando oder Stellvertretung irgendeiner Einheit
export function hatVerwaltung(profil) {
  return (
    profil.kantonsadmin === true ||
    profil.einheiten.some(
      (e) => e.rolle === "kommandant" || e.rolle === "stellvertretung",
    )
  );
}

// Stellvertretungen legt, ordnet und entfernt nur das Kommando (und der Kantonsadmin)
export function darfStellvertretungen(einheit) {
  return istKantonsadmin() || einheit?.rolle === "kommandant";
}

export const ROLLENNAME = {
  kommandant: "Kommando",
  stellvertretung: "Stellvertretung",
  leitung: "Leitung",
};

export const TYPNAME = { jf: "Jugendfeuerwehr", kf: "Kinderfeuerwehr" };

export async function ladeKontext() {
  kontext.profil = await anfrage("GET", "/api/v1/ich");
  kontext.einheiten = [];
  return kontext.profil;
}

// Erst nach dem zweiten Faktor: Die Liste der Einheiten ist eine Admin-Route
export async function ladeEinheiten() {
  const { einheiten } = await anfrage("GET", "/api/v1/admin/einheiten");
  kontext.einheiten = einheiten;
  let gemerkt = null;
  try {
    gemerkt = sessionStorage.getItem(SCHLUESSEL);
  } catch {
    // Ohne Speicher gilt die erste Einheit
  }
  kontext.aktiveId = einheiten.some((e) => e.id === kontext.aktiveId)
    ? kontext.aktiveId
    : einheiten.some((e) => e.id === gemerkt)
      ? gemerkt
      : (einheiten[0]?.id ?? null);
  return einheiten;
}

export function waehleEinheit(id) {
  kontext.aktiveId = id;
  try {
    sessionStorage.setItem(SCHLUESSEL, id);
  } catch {
    // Die Wahl gilt dann nur bis zum Neuladen
  }
}

export function rollenText(profil) {
  if (profil.kantonsadmin) return "Kantonsadmin";
  if (profil.einheiten.some((e) => e.rolle === "kommandant")) return "Kommando";
  return "Stellvertretung";
}

// Die Einheiten nach Bezirk gruppiert, Bezirke und Einheiten in der Reihenfolge der API
function nachBezirk(einheiten) {
  const gruppen = new Map();
  for (const e of einheiten) {
    if (!gruppen.has(e.bezirkId)) {
      gruppen.set(e.bezirkId, { name: e.bezirk, einheiten: [] });
    }
    gruppen.get(e.bezirkId).einheiten.push(e);
  }
  return [...gruppen.values()];
}

// Umschalter Bezirk/Einheit: ein Seitenblatt mit allen Einheiten, die das Konto sehen darf (der Kantonsadmin alle); beiWahl läuft nach der Wahl
export function zeigeUmschalter(beiWahl) {
  const such = neueId("umschalter-suche");
  const suche = el("input", {
    id: such,
    class: "eingabe",
    type: "search",
    placeholder: "Einheit oder Bezirk",
    autocomplete: "off",
  });
  const liste = el("div", { class: "umschalter" });
  let blatt;
  const zeichne = () => {
    const frage = suche.value.trim().toLowerCase();
    const treffer = kontext.einheiten.filter((e) =>
      `${e.name} ${e.bezirk}`.toLowerCase().includes(frage),
    );
    liste.replaceChildren(
      treffer.length === 0
        ? el("p", { class: "leer leer--klein" }, "Keine Einheit gefunden.")
        : nachBezirk(treffer).map((gruppe) => {
            const titelId = neueId("bezirk");
            return el(
              "section",
              { "aria-labelledby": titelId },
              el("h3", { id: titelId }, `Bezirk ${gruppe.name}`),
              el(
                "ul",
                { class: "umschalter-liste" },
                gruppe.einheiten.map((e) =>
                  el(
                    "li",
                    {},
                    el(
                      "button",
                      {
                        type: "button",
                        class: "umschalter-eintrag",
                        "aria-pressed": String(e.id === kontext.aktiveId),
                        onclick: () => {
                          waehleEinheit(e.id);
                          blatt.close();
                          beiWahl();
                        },
                      },
                      icon("einheit"),
                      el(
                        "span",
                        { class: "umschalter-text" },
                        el("span", { class: "name" }, e.name),
                        el("span", { class: "mini leise" }, TYPNAME[e.typ]),
                      ),
                      e.id === kontext.aktiveId && icon("haken"),
                    ),
                  ),
                ),
              ),
            );
          }),
    );
  };
  suche.addEventListener("input", zeichne);
  zeichne();
  blatt = seitenblatt({
    titel: "Einheit wechseln",
    untertitel:
      "Die Verwaltung zeigt immer genau eine Einheit. Jede Einheit hat eigene Konten und Ränge.",
    inhalt: [
      el(
        "div",
        { class: "suche suche--voll" },
        el("label", { class: "nur-leser", for: such }, "Einheit suchen"),
        icon("lupe"),
        suche,
      ),
      liste,
    ],
  });
  return blatt;
}
