import { el, icon, knopf, neueId } from "./dom.js";
import {
  MONATE,
  WOCHENTAGE,
  begrenze,
  formatDe,
  heute,
  imBereich,
  langDe,
  monatErlaubt,
  monatsraster,
  parseDe,
  teile,
  verschiebe,
  wochentag,
} from "./datum.js";

// Datumsfeld mit Kalender statt des Browser-Pickers: Textfeld (TT.MM.JJJJ) mit Knopf, der den Monat in einem Popover zeigt.
// Der Wert bleibt «yyyy-mm-dd» und liegt wie bei auswahl() in einem versteckten Feld (eingabe): .value lesen und auf «change» hören wie bei type="date". Ungültiger Text oder ein Datum ausserhalb von min/max ergibt den Wert "" und eine Meldung unter dem Feld.
// min, max: «yyyy-mm-dd» oder leer; optional: leer ist erlaubt und der Kalender hat den Knopf «Löschen»; weitere Eigenschaften (z. B. required) gehen an das Textfeld.
// Tasten im Kalender: Pfeile ±1 Tag und ±1 Woche, Bild auf/ab ±1 Monat (mit Umschalt ±1 Jahr), Pos1/Ende Wochenanfang und -ende, Enter wählt, Escape schliesst und gibt den Fokus ans Feld zurück.
export function datumfeld({
  label,
  wert = "",
  min = "",
  max = "",
  optional = false,
  hilfe,
  ...rest
}) {
  const id = neueId("datum");
  const popId = `${id}-kalender`;
  const titelId = `${id}-titel`;
  const fehlerId = `${id}-fehler`;
  const hinweisId = `${id}-format`;
  const hilfeId = `${id}-hilfe`;
  const beschreibung = [hinweisId, hilfe && hilfeId].filter(Boolean).join(" ");

  const eingabe = el("input", { type: "hidden" });
  eingabe.value = teile(wert) && imBereich(wert, min, max) ? wert : "";
  const text = el("input", {
    id,
    type: "text",
    class: "datum-eingabe",
    inputmode: "numeric",
    autocomplete: "off",
    maxlength: "10",
    placeholder: "TT.MM.JJJJ",
    "aria-describedby": beschreibung,
    ...rest,
  });
  text.value = formatDe(eingabe.value);

  let fokus = ""; // Tag mit dem Tabulatorstopp im Raster; sein Monat ist der gezeigte
  const heuteKnopf = knopf("Heute", {
    klein: true,
    onclick: () => waehle(heute()),
  });
  const loeschen =
    optional && knopf("Löschen", { klein: true, onclick: () => waehle("") });
  const titel = el("p", {
    id: titelId,
    class: "datum-titel",
    "aria-live": "polite",
    "aria-atomic": "true",
  });
  const navigation = [
    ["linksLinks", "Vorheriges Jahr", { jahre: -1 }],
    ["links", "Vorheriger Monat", { monate: -1 }],
    ["rechts", "Nächster Monat", { monate: 1 }],
    ["rechtsRechts", "Nächstes Jahr", { jahre: 1 }],
  ].map(([symbol, name, schritt]) => {
    const k = el(
      "button",
      {
        type: "button",
        class: "knopf knopf--rund",
        "aria-label": name,
        // aria-disabled statt disabled: Der Fokus bleibt auf dem Knopf, wenn der Monat dahinter nicht mehr erlaubt ist
        onclick: () =>
          k.getAttribute("aria-disabled") !== "true" && springe(schritt),
      },
      icon(symbol),
    );
    k.schritt = schritt;
    return k;
  });
  const koerper = el("tbody");
  const popover = el(
    "div",
    {
      id: popId,
      class: "datum-popover",
      popover: "manual",
      role: "dialog",
      "aria-label": `Datum wählen: ${label}`,
    },
    el(
      "div",
      { class: "datum-kopf" },
      navigation[0],
      navigation[1],
      titel,
      navigation[2],
      navigation[3],
    ),
    el(
      "table",
      { class: "datum-raster", role: "grid", "aria-labelledby": titelId },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          WOCHENTAGE.map(([kurz, lang]) =>
            el(
              "th",
              { scope: "col" },
              el("span", { "aria-hidden": "true" }, kurz),
              el("span", { class: "nur-leser" }, lang),
            ),
          ),
        ),
      ),
      koerper,
    ),
    el("div", { class: "datum-fuss" }, heuteKnopf, loeschen),
  );
  const oeffner = el(
    "button",
    {
      type: "button",
      class: "knopf knopf--rund datum-knopf",
      "aria-label": `Kalender öffnen: ${label}`,
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      "aria-controls": popId,
      onclick: () =>
        popover.matches(":popover-open") ? schliesse(true) : oeffne(),
    },
    icon("kalender"),
  );
  const gruppe = el("div", { class: "datum" }, text, oeffner, popover);

  function zeichne() {
    const [j, m] = teile(fokus);
    const heuteIso = heute();
    titel.textContent = `${MONATE[m - 1]} ${j}`;
    heuteKnopf.disabled = !imBereich(heuteIso, min, max);
    for (const k of navigation) {
      const [jz, mz] = teile(verschiebe(fokus, k.schritt));
      k.setAttribute("aria-disabled", String(!monatErlaubt(jz, mz, min, max)));
    }
    koerper.replaceChildren(
      ...monatsraster(j, m).map((woche) =>
        el(
          "tr",
          {},
          woche.map(({ iso, imMonat }) =>
            el(
              "td",
              {
                role: "gridcell",
                "aria-selected": String(iso === eingabe.value),
              },
              el(
                "button",
                {
                  type: "button",
                  class: [
                    "datum-tag",
                    !imMonat && "datum-tag--fremd",
                    iso === heuteIso && "datum-tag--heute",
                  ]
                    .filter(Boolean)
                    .join(" "),
                  tabindex: iso === fokus ? "0" : "-1",
                  "aria-label": langDe(iso),
                  "aria-current": iso === heuteIso ? "date" : undefined,
                  "data-datum": iso,
                  disabled: !imBereich(iso, min, max),
                  onclick: () => waehle(iso),
                },
                String(Number(iso.slice(8))),
              ),
            ),
          ),
        ),
      ),
    );
  }

  const tagKnopf = () => koerper.querySelector(`[data-datum="${fokus}"]`);

  // Fokus auf einen anderen Tag; im selben Monat wandert nur der Tabulatorstopp, sonst wird neu gezeichnet
  function bewege(ziel) {
    const neuerMonat = ziel.slice(0, 7) !== fokus.slice(0, 7);
    koerper.querySelector('[tabindex="0"]')?.setAttribute("tabindex", "-1");
    fokus = ziel;
    if (neuerMonat) zeichne();
    else tagKnopf().setAttribute("tabindex", "0");
    tagKnopf().focus();
  }

  // Monats- und Jahrespfeile: der gezeigte Monat wechselt, der Fokus bleibt auf dem Pfeil
  function springe(schritt) {
    fokus = begrenze(verschiebe(fokus, schritt), min, max);
    zeichne();
  }

  function schreibe(iso, anzeige = formatDe(iso)) {
    text.value = anzeige;
    if (eingabe.value === iso) return;
    eingabe.value = iso;
    eingabe.dispatchEvent(new window.Event("change", { bubbles: true }));
  }

  function zeigeFehler(meldung) {
    text.closest(".feld")?.querySelector(".feld-fehler")?.remove();
    if (meldung) text.setAttribute("aria-invalid", "true");
    else text.removeAttribute("aria-invalid");
    text.setAttribute(
      "aria-describedby",
      [beschreibung, meldung && fehlerId].filter(Boolean).join(" "),
    );
    if (meldung) {
      text
        .closest(".feld")
        .append(
          el(
            "p",
            { class: "feld-fehler", id: fehlerId, role: "alert" },
            meldung,
          ),
        );
    }
  }

  function waehle(iso) {
    zeigeFehler(null);
    schreibe(iso);
    schliesse(true);
  }

  function grenzen() {
    if (min && max)
      return `Bitte ein Datum zwischen ${formatDe(min)} und ${formatDe(max)} wählen.`;
    return min
      ? `Bitte ein Datum ab ${formatDe(min)} wählen.`
      : `Bitte ein Datum bis ${formatDe(max)} wählen.`;
  }

  // Getippter Text: gültig und im Bereich wird zum Wert (und umformatiert), alles andere ergibt den Wert "" mit Meldung
  text.addEventListener("change", () => {
    const getippt = text.value.trim();
    const iso = parseDe(getippt);
    if (getippt === "" && optional) {
      zeigeFehler(null);
      schreibe("");
    } else if (getippt === "") {
      zeigeFehler("Bitte ein Datum eingeben.");
      schreibe("");
    } else if (!iso) {
      zeigeFehler("Bitte als TT.MM.JJJJ schreiben, zum Beispiel 05.03.2026.");
      schreibe("", getippt);
    } else if (!imBereich(iso, min, max)) {
      zeigeFehler(grenzen());
      schreibe("", getippt);
    } else {
      zeigeFehler(null);
      schreibe(iso);
    }
  });
  text.addEventListener("input", () => zeigeFehler(null));
  text.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && e.altKey) {
      e.preventDefault();
      oeffne();
    }
  });

  // Die Lage stimmt nach Scrollen oder Grössenänderung nicht mehr: schliessen statt nachführen
  const beiLageAenderung = (e) => {
    if (!popover.contains(e.target)) schliesse(false);
  };
  const beiKlickDaneben = (e) => {
    if (!popover.contains(e.target) && !oeffner.contains(e.target))
      schliesse(false);
  };

  function platziere() {
    const r = gruppe.getBoundingClientRect();
    const hoehe = popover.offsetHeight;
    const unten = r.bottom + 4;
    const oben = r.top - 4 - hoehe;
    const y = unten + hoehe > window.innerHeight && oben >= 8 ? oben : unten;
    const x = Math.min(r.left, window.innerWidth - popover.offsetWidth - 8);
    popover.style.top = `${Math.max(8, y)}px`;
    popover.style.left = `${Math.max(8, x)}px`;
  }

  function oeffne() {
    fokus = begrenze(parseDe(text.value) ?? heute(), min, max);
    zeichne();
    popover.showPopover();
    platziere();
    oeffner.setAttribute("aria-expanded", "true");
    tagKnopf().focus();
    window.addEventListener("resize", beiLageAenderung);
    document.addEventListener("scroll", beiLageAenderung, true);
    document.addEventListener("pointerdown", beiKlickDaneben, true);
  }

  function schliesse(fokusZurueck) {
    if (popover.matches(":popover-open")) popover.hidePopover();
    window.removeEventListener("resize", beiLageAenderung);
    document.removeEventListener("scroll", beiLageAenderung, true);
    document.removeEventListener("pointerdown", beiKlickDaneben, true);
    oeffner.setAttribute("aria-expanded", "false");
    if (fokusZurueck) text.focus();
  }

  koerper.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const woche = wochentag(fokus);
    const ziele = {
      ArrowLeft: { tage: -1 },
      ArrowRight: { tage: 1 },
      ArrowUp: { tage: -7 },
      ArrowDown: { tage: 7 },
      Home: { tage: -woche },
      End: { tage: 6 - woche },
      PageUp: e.shiftKey ? { jahre: -1 } : { monate: -1 },
      PageDown: e.shiftKey ? { jahre: 1 } : { monate: 1 },
    };
    if (!ziele[e.key]) return;
    e.preventDefault();
    bewege(begrenze(verschiebe(fokus, ziele[e.key]), min, max));
  });
  popover.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // Auch ein umgebender Dialog bliebe sonst nicht offen
    e.preventDefault();
    e.stopPropagation();
    schliesse(true);
  });
  // Tab aus dem Kalender heraus schliesst ihn; auf den Öffnen-Knopf entscheidet dessen Klick
  popover.addEventListener("focusout", (e) => {
    if (
      e.relatedTarget &&
      !popover.contains(e.relatedTarget) &&
      e.relatedTarget !== oeffner
    )
      schliesse(false);
  });
  // mousedown neben den Knöpfen nicht übernehmen, sonst verliert der Kalender den Fokus und Escape griffe nicht mehr
  popover.addEventListener("mousedown", (e) => {
    if (!e.target.closest("button")) e.preventDefault();
  });

  return {
    wurzel: el(
      "div",
      { class: "feld" },
      el("label", { for: id }, label),
      gruppe,
      eingabe,
      el(
        "span",
        { id: hinweisId, class: "nur-leser" },
        "Format TT.MM.JJJJ. Mit Alt und Pfeil nach unten öffnet sich der Kalender.",
      ),
      hilfe && el("p", { class: "hilfe", id: hilfeId }, hilfe),
    ),
    eingabe,
  };
}
