import { anfrage, ApiFehler } from "./api.js";
import { bestaetigen, chip, el, geheimnisDialog, neueId, tag } from "./dom.js";

// Aktionen und Zustände, die für jedes Konto gleich sind: Personen (Kommando, Stellvertretungen, Leitende) und die Konten der Teilnehmenden. Welche Aktion ein Konto bekommt, sagt die API in konto.aktionen; fehlt sie dort, fehlt der Knopf.

const url = (einheit, konto, aktion) =>
  `/api/v1/admin/einheiten/${einheit.id}/personen/${konto.id}${aktion ? `/${aktion}` : ""}`;

// Chips mit Symbol und Wort; der Zustand steht nie nur in der Farbe
export function zustandsChips(konto, { verwaltung = false } = {}) {
  const liste = [
    verwaltung && chip("Verwaltung", undefined, "stern"),
    konto.zweiterFaktor && chip("Zweiter Faktor", "ok", "schild"),
  ];
  if (konto.startpasswort) {
    const frist = konto.startpasswort.gueltigBis;
    liste.push(
      konto.startpasswort.abgelaufen
        ? chip("Startpasswort abgelaufen", "fehler", "uhr")
        : chip(`Startpasswort bis ${tag(frist)}`, "warn", "schluessel"),
    );
  }
  if (konto.deaktiviert) liste.push(chip("Deaktiviert", "fehler", "sperre"));
  if (konto.eigenes) liste.push(chip("Das bist du", undefined, "info"));
  return liste.filter(Boolean);
}

const dialogText = (konto) =>
  `Gib das Startpasswort für «${konto.name}» sicher weiter. Es gilt 7 Tage. Es steht nur in diesem Fenster und ist weg, sobald du es schliesst; solange es offen ist, zeigt die Verwaltung es dir wieder an.`;

// Zeigt das offene Startpasswort; ist keines mehr offen, sagt die API es (409)
export async function startpasswortAnzeigen(konto, einheit, ctx) {
  try {
    const { startpasswort } = await anfrage(
      "GET",
      url(einheit, konto, "startpasswort"),
    );
    geheimnisDialog({
      titel: "Startpasswort",
      beschreibung: dialogText(konto),
      wert: startpasswort,
    });
  } catch (f) {
    ctx.melde(
      f instanceof ApiFehler && f.code === "KEIN_STARTPASSWORT"
        ? "Es ist kein Startpasswort mehr offen. Erzeuge ein neues."
        : "Das Startpasswort lässt sich nicht anzeigen.",
      "fehler",
    );
  }
}

// neu(): lädt die Ansicht nochmals; fertig(): schliesst ein Seitenblatt, dessen Angaben danach veraltet sind
export function startpasswortNeu(konto, einheit, ctx, neu, fertig = () => {}) {
  bestaetigen({
    titel: "Neues Startpasswort erzeugen",
    beschreibung: `«${konto.name}» wird überall abgemeldet und muss beim nächsten Login ein neues Passwort wählen. Das Startpasswort gilt 7 Tage.`,
    ok: "Startpasswort erzeugen",
    gefaehrlich: false,
    aktion: () => anfrage("POST", url(einheit, konto, "startpasswort")),
    danach: (antwort) => {
      neu();
      ctx.melde(`Neues Startpasswort für «${konto.name}» ist erzeugt.`);
      geheimnisDialog({
        titel: "Startpasswort",
        beschreibung: dialogText(konto),
        wert: antwort.startpasswort,
      });
      fertig();
    },
  });
}

export function deaktivieren(konto, einheit, ctx, neu, fertig = () => {}) {
  bestaetigen({
    titel: "Konto deaktivieren",
    beschreibung: `«${konto.name}» kann sich nicht mehr anmelden und wird überall abgemeldet. Das Profilbild wird gelöscht. Das Konto lässt sich wieder aktivieren.`,
    ok: "Deaktivieren",
    aktion: () => anfrage("POST", url(einheit, konto, "deaktivieren")),
    danach: () => {
      neu();
      ctx.melde(`«${konto.name}» ist deaktiviert.`);
      fertig();
    },
  });
}

export function aktivieren(konto, einheit, ctx, neu, fertig = () => {}) {
  bestaetigen({
    titel: "Konto aktivieren",
    beschreibung: `«${konto.name}» kann sich wieder anmelden.`,
    ok: "Aktivieren",
    gefaehrlich: false,
    aktion: () => anfrage("POST", url(einheit, konto, "aktivieren")),
    danach: () => {
      neu();
      ctx.melde(`«${konto.name}» ist aktiviert.`);
      fertig();
    },
  });
}

export function faktorZuruecksetzen(
  konto,
  einheit,
  ctx,
  neu,
  fertig = () => {},
) {
  bestaetigen({
    titel: "Zweiten Faktor zurücksetzen",
    beschreibung: `«${konto.name}» muss den zweiten Faktor danach neu einrichten und kommt bis dahin nicht in die Verwaltung.`,
    ok: "Zurücksetzen",
    aktion: () =>
      anfrage("POST", url(einheit, konto, "zweiter-faktor-zuruecksetzen")),
    danach: () => {
      neu();
      ctx.melde(`Der zweite Faktor von «${konto.name}» ist zurückgesetzt.`);
      fertig();
    },
  });
}

// Einträge für das Menü «Mehr» einer Zeile, nur die Aktionen, die die API erlaubt
export function kontoMenueEintraege(konto, einheit, ctx, neu, fertig) {
  const a = konto.aktionen;
  return [
    a.startpasswort &&
      konto.startpasswort &&
      !konto.startpasswort.abgelaufen && {
        text: "Startpasswort anzeigen",
        onclick: () => startpasswortAnzeigen(konto, einheit, ctx),
      },
    a.startpasswort && {
      text: "Neues Startpasswort",
      onclick: () => startpasswortNeu(konto, einheit, ctx, neu, fertig),
    },
    a.zweiterFaktor &&
      konto.zweiterFaktor && {
        text: "Zweiten Faktor zurücksetzen",
        onclick: () => faktorZuruecksetzen(konto, einheit, ctx, neu, fertig),
      },
    a.deaktivieren &&
      (konto.deaktiviert
        ? {
            text: "Aktivieren",
            onclick: () => aktivieren(konto, einheit, ctx, neu, fertig),
          }
        : {
            text: "Deaktivieren",
            gefaehrlich: true,
            onclick: () => deaktivieren(konto, einheit, ctx, neu, fertig),
          }),
  ];
}

// Gelber Hinweis oben: offene Aufgaben; ohne Aufgaben kein Element
export function aufgabenHinweis(zeilen) {
  const offen = zeilen.filter(Boolean);
  if (offen.length === 0) return null;
  return el(
    "div",
    { class: "hinweis hinweis--warn", role: "status" },
    el(
      "ul",
      { class: "aufgaben" },
      offen.map((text) => el("li", {}, text)),
    ),
  );
}

export const mehrzahl = (n, einzahl, mehrfach) =>
  `${n} ${n === 1 ? einzahl : mehrfach}`;

// Die Felder für ein neues Konto sind überall gleich
// Vorschläge unter einem Feld für ein bestehendes Konto: ab 2 Zeichen nach Name (die API findet auch Benutzernamen). Die Liste zeigt nur Namen; der Benutzername bleibt am Feld und geht über kontoWert an die API. fuer: «leitung» oder «eltern». Die API zeigt nur, was das Kommando auch zuweisen darf; ein Fehler leert die Liste
export function kontoVorschlaege(feld, einheit, fuer) {
  const { eingabe } = feld;
  const liste = el("ul", {
    class: "vorschlaege",
    id: neueId("vorschlaege"),
    role: "listbox",
    "aria-label": "Konten",
    hidden: true,
  });
  const huelle = el("div", { class: "vorschlag-huelle" });
  eingabe.replaceWith(huelle);
  huelle.append(eingabe, liste);
  eingabe.setAttribute("role", "combobox");
  eingabe.setAttribute("aria-autocomplete", "list");
  eingabe.setAttribute("aria-controls", liste.id);
  eingabe.setAttribute("aria-expanded", "false");

  let warte;
  let lauf = 0;
  let aktiv = -1;
  const eintraege = () => [
    ...liste.querySelectorAll('[role="option"][data-benutzername]'),
  ];
  const zeige = (i) => {
    aktiv = i;
    eintraege().forEach((li, n) => {
      li.setAttribute("aria-selected", String(n === i));
      if (n === i) {
        eingabe.setAttribute("aria-activedescendant", li.id);
        li.scrollIntoView({ block: "nearest" });
      }
    });
    if (i < 0) eingabe.removeAttribute("aria-activedescendant");
  };
  const schliesse = () => {
    lauf++;
    clearTimeout(warte);
    liste.hidden = true;
    liste.replaceChildren();
    eingabe.setAttribute("aria-expanded", "false");
    zeige(-1);
  };
  const waehle = (li) => {
    eingabe.value = li.textContent;
    eingabe.dataset.benutzername = li.dataset.benutzername;
    schliesse();
  };
  const fuelle = (konten) => {
    liste.replaceChildren(
      ...(konten.length === 0
        ? [
            el(
              "li",
              {
                role: "option",
                "aria-disabled": "true",
                class: "vorschlag vorschlag--leer",
              },
              "Kein passendes Konto",
            ),
          ]
        : konten.map((k) =>
            el(
              "li",
              {
                role: "option",
                id: neueId("vorschlag"),
                class: "vorschlag",
                "aria-selected": "false",
                "data-benutzername": k.benutzername,
              },
              k.name,
            ),
          )),
    );
    liste.hidden = false;
    eingabe.setAttribute("aria-expanded", "true");
    zeige(-1);
  };

  eingabe.addEventListener("input", () => {
    // Wer nach der Auswahl weitertippt, wählt neu
    delete eingabe.dataset.benutzername;
    clearTimeout(warte);
    const q = eingabe.value.trim();
    const nr = ++lauf;
    if (q.length < 2) {
      schliesse();
      return;
    }
    warte = setTimeout(async () => {
      try {
        const antwort = await anfrage(
          "GET",
          `/api/v1/admin/einheiten/${einheit.id}/konten-suche?fuer=${fuer}&q=${encodeURIComponent(q)}`,
        );
        if (nr === lauf) fuelle(antwort.konten);
      } catch {
        if (nr === lauf) schliesse();
      }
    }, 250);
  });
  eingabe.addEventListener("keydown", (e) => {
    const offen = !liste.hidden;
    const n = eintraege().length;
    if (e.key === "Escape" && offen) {
      // Schliesst nur die Liste, nicht den Dialog
      e.preventDefault();
      e.stopPropagation();
      schliesse();
    } else if (e.key === "ArrowDown" && offen && n > 0) {
      e.preventDefault();
      zeige((aktiv + 1) % n);
    } else if (e.key === "ArrowUp" && offen && n > 0) {
      e.preventDefault();
      zeige((aktiv - 1 + n) % n);
    } else if (e.key === "Enter" && offen && aktiv >= 0) {
      e.preventDefault();
      waehle(eintraege()[aktiv]);
    }
  });
  eingabe.addEventListener("blur", schliesse);
  // mousedown statt click: Das Feld verliert sonst den Fokus und schliesst die Liste vor der Auswahl
  liste.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const li = e.target.closest("[data-benutzername]");
    if (li) waehle(li);
  });
}

// Der Benutzername des gewählten Kontos; ohne Auswahl der getippte Text
export const kontoWert = ({ eingabe }) =>
  eingabe.dataset.benutzername ?? eingabe.value.trim();

export const BENUTZERNAME_HILFE =
  "3 bis 64 Zeichen: Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich. Gross- und Kleinschreibung zählt nicht.";
