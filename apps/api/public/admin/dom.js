// Bausteine für die Oberfläche. Daten gelangen nur als Text (createTextNode, textContent) in die Seite, nie als HTML.

import { fehlertext as standardFehlertext } from "./api.js";

let zaehler = 0;
export const neueId = (vorsatz) => `${vorsatz}-${++zaehler}`;

// el("button", { class: "knopf", onclick: fn }, "Text", kind)
export function el(tag, eigenschaften = {}, ...kinder) {
  const knoten = document.createElement(tag);
  for (const [name, wert] of Object.entries(eigenschaften)) {
    if (wert === undefined || wert === null || wert === false) continue;
    if (name.startsWith("on")) knoten.addEventListener(name.slice(2), wert);
    else if (wert === true) knoten.setAttribute(name, "");
    else knoten.setAttribute(name, String(wert));
  }
  for (const kind of kinder.flat()) {
    if (kind === undefined || kind === null || kind === false) continue;
    knoten.append(kind instanceof Node ? kind : document.createTextNode(kind));
  }
  return knoten;
}

export function leere(knoten) {
  knoten.replaceChildren();
}

const datum = new Intl.DateTimeFormat("de-CH", {
  dateStyle: "medium",
  timeStyle: "short",
});
const nurTag = new Intl.DateTimeFormat("de-CH", { dateStyle: "medium" });
export function tag(iso) {
  const wert = new Date(iso);
  return Number.isNaN(wert.getTime()) ? "" : nurTag.format(wert);
}

export function zeit(iso) {
  const wert = new Date(iso);
  return Number.isNaN(wert.getTime()) ? "" : datum.format(wert);
}

// Icons der Vorlage (24er Raster, Strich über CSS); ein String ist ein Pfad, sonst [Tag, Eigenschaften]
const ICONS = {
  personen: [
    ["circle", { cx: 9, cy: 8, r: 3.5 }],
    "M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5",
    "M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.9.7 3.1 2.4 3.5 5.2",
  ],
  stufen: [
    "M12 3 2.5 7.5 12 12l9.5-4.5z",
    "m2.5 12 9.5 4.5 9.5-4.5",
    "m2.5 16.5 9.5 4.5 9.5-4.5",
  ],
  kinder: [
    ["circle", { cx: 12, cy: 12, r: 9 }],
    "M8.5 14.5c1 1.3 2.1 2 3.5 2s2.5-.7 3.5-2",
    "M9 9.5h.01M15 9.5h.01",
  ],
  system: ["M3 12h4l2.5-6 5 12 2.5-6h4"],
  auswertung: ["M4 20V11", "M10 20V4", "M16 20v-6", "M2 20h20"],
  einheit: ["M4 21V9l8-5 8 5v12", "M9 21v-6h6v6M3 21h18"],
  zeitregeln: [["circle", { cx: 12, cy: 13, r: 8 }], "M12 9v4l2.5 2", "M9 2h6"],
  hochladen: [
    "M12 16V5",
    "m7.5 9.5 4.5-4.5 4.5 4.5",
    "M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
  ],
  uebersicht: [
    ["rect", { x: 3, y: 3, width: 8, height: 10, rx: 2 }],
    ["rect", { x: 13, y: 3, width: 8, height: 6, rx: 2 }],
    ["rect", { x: 13, y: 12, width: 8, height: 9, rx: 2 }],
    ["rect", { x: 3, y: 16, width: 8, height: 5, rx: 2 }],
  ],
  ablage: [
    "M12 4v11",
    "m7.5 10.5 4.5 4.5 4.5-4.5",
    "M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
  ],
  glocke: ["M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z", "M10 21h4"],
  meldungen: ["M5 21V4", "M5 4h12l-2.5 4L17 12H5"],
  bearbeiten: ["M4 20h4L19 9l-4-4L4 16z", "m13.5 6.5 4 4"],
  plus: ["M12 5v14M5 12h14"],
  papierkorb: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
  haken: ["m5 12.5 4.5 4.5L19 7.5"],
  uhr: [["circle", { cx: 12, cy: 12, r: 9 }], "M12 7v5l3 2"],
  stern: [
    "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z",
  ],
  schild: [
    "M12 3 4 6v6c0 4.5 3.4 7.8 8 9 4.6-1.2 8-4.5 8-9V6z",
    "m8.5 12 2.5 2.5 4.5-5",
  ],
  sperre: [["circle", { cx: 12, cy: 12, r: 9 }], "M5.6 5.6l12.8 12.8"],
  lupe: [["circle", { cx: 11, cy: 11, r: 7 }], "m20 20-3.5-3.5"],
  abmelden: ["M14 4h5v16h-5", "M10 8l-4 4 4 4M6 12h10"],
  warnung: ["M12 3.5 2.5 20h19z", "M12 10v4M12 17h.01"],
  info: [["circle", { cx: 12, cy: 12, r: 9 }], "M12 11v5M12 8h.01"],
  schluessel: [["circle", { cx: 8, cy: 15, r: 4 }], "m11 12 9-9M16 7l3 3"],
  kopieren: [
    ["rect", { x: 8, y: 8, width: 12, height: 12, rx: 2 }],
    "M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3",
  ],
  schliessen: ["M6 6l12 12M18 6 6 18"],
  aktualisieren: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 5v6h-6"],
  hoch: ["M6 15l6-6 6 6"],
  runter: ["M6 9l6 6 6-6"],
  links: ["M15 6l-6 6 6 6"],
  rechts: ["M9 6l6 6-6 6"],
  linksLinks: ["M11 6l-6 6 6 6", "M18 6l-6 6 6 6"],
  rechtsRechts: ["M6 6l6 6-6 6", "M13 6l6 6-6 6"],
  kalender: [
    ["rect", { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5 }],
    "M3.5 10h17M8 3v4M16 3v4",
  ],
  telefon: [
    "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z",
  ],
};
const SVG_NS = "http://www.w3.org/2000/svg";

// SVG-Symbol für Knöpfe, Chips und Navigation; Zierde, daher für Screenreader versteckt. Der Name steht immer im Text daneben.
export function icon(name) {
  const knoten = document.createElementNS(SVG_NS, "svg");
  knoten.setAttribute("class", "i");
  knoten.setAttribute("viewBox", "0 0 24 24");
  knoten.setAttribute("aria-hidden", "true");
  for (const teil of ICONS[name] ?? []) {
    const [tagName, eigenschaften] =
      typeof teil === "string" ? ["path", { d: teil }] : teil;
    const form = document.createElementNS(SVG_NS, tagName);
    for (const [schluessel, wert] of Object.entries(eigenschaften)) {
      form.setAttribute(schluessel, String(wert));
    }
    knoten.append(form);
  }
  return knoten;
}

// Kreis mit Initialen (erster und letzter Namensteil, der mit einem Buchstaben beginnt); hell für Listen, blau fürs eigene Konto; mit bildUrl liegt das Profilbild darüber, die Initialen bleiben, falls es nicht lädt
export function avatar(name, { hell = false, bildUrl = null } = {}) {
  const teile = String(name ?? "")
    .split(/\s+/)
    .filter((t) => /^\p{L}/u.test(t));
  const buchstaben = [teile[0], teile.length > 1 ? teile.at(-1) : ""]
    .map((t) => (t ? Array.from(t)[0] : ""))
    .join("")
    .toLocaleUpperCase("de-CH");
  const bild =
    bildUrl &&
    el("img", {
      src: bildUrl,
      alt: "",
      loading: "lazy",
      onerror: (e) => e.target.remove(),
    });
  return el(
    "span",
    { class: hell ? "ava ava--hell" : "ava", "aria-hidden": "true" },
    buchstaben || "?",
    bild,
  );
}

// Zustand nie nur über Farbe: ok, warn und fehler tragen ein Symbol (iconName überschreibt es, false lässt es weg)
const CHIP_ICON = { ok: "haken", warn: "warnung", fehler: "sperre" };
export function chip(text, art, iconName) {
  const symbol = iconName === undefined ? CHIP_ICON[art] : iconName;
  return el(
    "li",
    { class: art ? `chip chip--${art}` : "chip" },
    symbol && icon(symbol),
    text,
  );
}

// Umschalter aus Knöpfen mit aria-pressed (genau einer gedrückt)
// eintraege: [{ text, n, wert }, …]; liefert { wurzel, wert(), setze(wert) }
export function filterGruppe({ beschriftung, eintraege, wert, beiAenderung }) {
  let aktuell = wert ?? eintraege[0]?.wert;
  const knoepfe = eintraege.map((e) =>
    el(
      "button",
      {
        type: "button",
        "aria-pressed": "false",
        onclick: () => {
          if (aktuell === e.wert) return;
          setze(e.wert);
          beiAenderung?.(e.wert);
        },
      },
      e.text,
      e.n !== undefined && [" ", el("span", { class: "n" }, String(e.n))],
    ),
  );
  function setze(neu) {
    aktuell = neu;
    knoepfe.forEach((k, i) =>
      k.setAttribute("aria-pressed", String(eintraege[i].wert === aktuell)),
    );
  }
  setze(aktuell);
  return {
    wurzel: el(
      "div",
      { class: "filter", role: "group", "aria-label": beschriftung },
      knoepfe,
    ),
    wert: () => aktuell,
    setze,
  };
}

// Seitenkopf: Überzeile, Titel (Fokusziel nach der Navigation), Untertitel und rechts die Hauptaktion
export function kopf({ ueber, titel, untertitel, aktion }) {
  return el(
    "header",
    { class: "kopf" },
    el(
      "div",
      { class: "kopf-text" },
      ueber && el("p", { class: "ueber" }, ueber),
      el("h1", { tabindex: "-1" }, titel),
      untertitel && el("p", { class: "leise" }, untertitel),
    ),
    el("div", { class: "kopf-aktion" }, aktion),
  );
}

// Tabelle mit versteckter Beschriftung und Spaltenköpfen; der Rahmen scrollt auf schmalen Bildschirmen waagrecht und ist dafür mit der Tastatur erreichbar
// spalten: ["Name", …]; die letzte heisst «Aktionen» und steht rechts; ["Anzahl", "zahl"] richtet eine Zahlenspalte rechts aus
export function tabelle({ beschriftung, spalten, zeilen }) {
  const koerper = el("tbody", {}, zeilen);
  const wurzel = el(
    "div",
    {
      class: "tabellenrahmen",
      role: "region",
      "aria-label": beschriftung,
      tabindex: "0",
    },
    el(
      "table",
      { class: "tabelle" },
      el("caption", { class: "nur-leser" }, beschriftung),
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          spalten.map((spalte) => {
            const [name, klasse] = Array.isArray(spalte)
              ? spalte
              : [spalte, spalte === "Aktionen" ? "rechts" : undefined];
            return el("th", { scope: "col", class: klasse }, name);
          }),
        ),
      ),
      koerper,
    ),
  );
  return { wurzel, koerper };
}

// Blättern in einer schon gefilterten Liste, höchstens SEITENGROESSE Zeilen pro Seite; ab einer Seite unsichtbar
// fenster(anzahl) meldet die Trefferzahl und gibt [von, bis) für slice() zurück; beiWechsel zeichnet danach neu
export const SEITENGROESSE = 50;
export function seitenwahl({ beiWechsel }) {
  let seite = 1;
  let seiten = 1;
  const status = el("span", { class: "klein leise", role: "status" });
  const gehe = (n, fokus) => {
    seite = n;
    beiWechsel();
    // Der Knopf, der eben geklickt wurde, ist auf der letzten oder ersten Seite gesperrt und verliert sonst den Fokus
    if (fokus.disabled) (fokus === zurueck ? weiter : zurueck).focus();
  };
  const zurueck = knopf("Zurück", {
    klein: true,
    onclick: () => gehe(seite - 1, zurueck),
  });
  const weiter = knopf("Weiter", {
    klein: true,
    onclick: () => gehe(seite + 1, weiter),
  });
  const wurzel = el(
    "nav",
    { class: "seitenwahl", "aria-label": "Seiten" },
    zurueck,
    status,
    weiter,
  );
  return {
    wurzel,
    fenster(anzahl) {
      seiten = Math.max(1, Math.ceil(anzahl / SEITENGROESSE));
      seite = Math.min(seite, seiten);
      wurzel.hidden = seiten === 1;
      status.textContent = `Seite ${seite} von ${seiten}`;
      zurueck.disabled = seite === 1;
      weiter.disabled = seite === seiten;
      return [(seite - 1) * SEITENGROESSE, seite * SEITENGROESSE];
    },
    // Nach Suche oder Filter beginnt die Liste wieder vorn
    anfang() {
      seite = 1;
    },
    // Springt auf die Seite, auf der die Zeile mit diesem Index steht
    zu(index) {
      seite = Math.floor(index / SEITENGROESSE) + 1;
    },
  };
}

// Zelle mit den Knöpfen einer Zeile; leere Einträge (false) fallen weg
export function aktionenZelle(...knoepfe) {
  return el(
    "td",
    { class: "rechts" },
    el("div", { class: "aktionen" }, knoepfe),
  );
}

// Weitere Aktionen einer Zeile hinter einem Knopf «Mehr»; ohne Einträge entfällt er
// eintraege: [{ text, onclick, gefaehrlich }, …] oder false
export function menue(kontext, eintraege) {
  const liste = eintraege.filter(Boolean);
  if (liste.length === 0) return false;
  return el(
    "details",
    { class: "menue" },
    el(
      "summary",
      { class: "knopf knopf--klein", "aria-label": `Mehr: ${kontext}` },
      "Mehr",
    ),
    el(
      "div",
      { class: "menue-liste" },
      liste.map((e) =>
        el(
          "button",
          {
            type: "button",
            class: e.gefaehrlich
              ? "menue-eintrag menue-eintrag--gefahr"
              : "menue-eintrag",
            "aria-label": `${e.text}: ${kontext}`,
            onclick: e.onclick,
          },
          e.text,
        ),
      ),
    ),
  );
}

// Offene Menüs schliessen: Klick daneben oder auf einen Eintrag, Escape (Fokus zurück auf «Mehr»), Fokus verlässt das Menü
document.addEventListener("click", (ereignis) => {
  for (const m of document.querySelectorAll("details.menue[open]")) {
    if (
      !m.contains(ereignis.target) ||
      ereignis.target.closest(".menue-eintrag")
    )
      m.open = false;
  }
});
document.addEventListener("keydown", (ereignis) => {
  if (ereignis.key !== "Escape") return;
  const offen = document.querySelector("details.menue[open]");
  if (!offen) return;
  offen.open = false;
  offen.querySelector("summary").focus();
});
document.addEventListener("focusout", (ereignis) => {
  const m = ereignis.target.closest?.("details.menue[open]");
  if (m && ereignis.relatedTarget && !m.contains(ereignis.relatedTarget)) {
    m.open = false;
  }
});

// Wer den Dialog öffnete: bei einem Menü-Eintrag der Knopf «Mehr», denn das Menü schliesst sich danach
function ausloeser() {
  const aktiv = document.activeElement;
  return aktiv?.closest?.("details.menue")?.querySelector("summary") ?? aktiv;
}

// Der Name beginnt mit dem sichtbaren Text, damit Sprachsteuerung ihn trifft; der Zusatz sagt, für wen
// symbol: Name eines Icons aus icon(), steht vor dem Text
export function knopf(text, { art, klein, kontext, symbol, ...rest } = {}) {
  return el(
    "button",
    {
      type: "button",
      class: ["knopf", art && `knopf--${art}`, klein && "knopf--klein"]
        .filter(Boolean)
        .join(" "),
      "aria-label": kontext ? `${text}: ${kontext}` : undefined,
      ...rest,
    },
    symbol && icon(symbol),
    text,
  );
}

// Beschriftetes Feld; bleibt sichtbar, auch beim Tippen
export function feld({
  label,
  typ = "text",
  wert = "",
  hilfe,
  mehrzeilig,
  ...rest
}) {
  const id = neueId("feld");
  const hilfeId = hilfe ? `${id}-hilfe` : undefined;
  const eingabe = el(mehrzeilig ? "textarea" : "input", {
    id,
    type: mehrzeilig ? undefined : typ,
    "aria-describedby": hilfeId,
    ...rest,
  });
  eingabe.value = wert;
  const wurzel = el(
    "div",
    { class: "feld" },
    el("label", { for: id }, label),
    eingabe,
    hilfe && el("p", { class: "hilfe", id: hilfeId }, hilfe),
  );
  return { wurzel, eingabe };
}

// Code-Feld mit gezeichneten Zellen: Eine echte Eingabe (unsichtbar, darübergelegt) hält den Wert, damit Einfügen, Autofill und Screenreader wie bei einem normalen Feld funktionieren. Bei der letzten Ziffer wird das Formular abgeschickt.
export function codefeld({ label, hilfe, stellen = 6, ...rest }) {
  const id = neueId("feld");
  const hilfeId = hilfe ? `${id}-hilfe` : undefined;
  const eingabe = el("input", {
    id,
    type: "text",
    inputmode: "numeric",
    autocomplete: "one-time-code",
    maxlength: String(stellen),
    pattern: "[0-9]*",
    "aria-describedby": hilfeId,
    ...rest,
  });
  const zellen = Array.from({ length: stellen }, () =>
    el("span", { class: "code-zelle" }),
  );
  const zeichne = () => {
    const ziffern = eingabe.value;
    const aktiv = Math.min(ziffern.length, stellen - 1);
    zellen.forEach((zelle, i) => {
      zelle.textContent = ziffern[i] ?? "";
      zelle.classList.toggle(
        "code-zelle--aktiv",
        document.activeElement === eingabe && i === aktiv,
      );
    });
  };
  eingabe.addEventListener("input", () => {
    eingabe.value = eingabe.value.replace(/\D/g, "").slice(0, stellen);
    eingabe.removeAttribute("aria-invalid");
    zeichne();
    if (eingabe.value.length === stellen) eingabe.form?.requestSubmit();
  });
  eingabe.addEventListener("focus", zeichne);
  eingabe.addEventListener("blur", zeichne);
  const wurzel = el(
    "div",
    { class: "feld" },
    el("label", { for: id }, label),
    el(
      "div",
      { class: "code-feld" },
      eingabe,
      el("div", { class: "code-zellen", "aria-hidden": "true" }, zellen),
    ),
    hilfe && el("p", { class: "hilfe", id: hilfeId }, hilfe),
  );
  return { wurzel, eingabe };
}

// Eigene Auswahl (Combobox mit Liste); das versteckte select hält den Wert, damit .eingabe.value und «change» wie bei einem normalen Feld funktionieren
// optionen: [[wert, beschriftung, bild?], …]; bild ist die URL oder ein Element (wird je Anzeige kopiert) vor der Beschriftung
export function auswahl({ label, optionen, wert, ...rest }) {
  const id = neueId("auswahl");
  const listeId = `${id}-liste`;
  const feldSelect = el(
    "select",
    { hidden: true, tabindex: "-1", "aria-hidden": "true", ...rest },
    optionen.map(([w, text]) => el("option", { value: w }, text)),
  );
  feldSelect.value = wert;
  const inhalt = ([, beschriftung, bild]) =>
    el(
      "span",
      { class: "auswahl-wert" },
      bild &&
        (typeof bild === "string"
          ? el("img", { class: "auswahl-bild", src: bild, alt: "" })
          : bild.cloneNode(true)),
      beschriftung,
    );
  const text = el("span", { class: "auswahl-wert" });
  const knopf = el(
    "button",
    {
      type: "button",
      id,
      class: "auswahl-knopf",
      role: "combobox",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      "aria-controls": listeId,
      "aria-labelledby": `${id}-label ${id}`,
    },
    text,
  );
  const eintraege = optionen.map((option, i) =>
    el(
      "li",
      { id: `${id}-o${i}`, role: "option", class: "auswahl-eintrag" },
      inhalt(option),
    ),
  );
  const liste = el(
    "ul",
    {
      id: listeId,
      class: "auswahl-liste",
      role: "listbox",
      "aria-labelledby": `${id}-label`,
      popover: "manual",
    },
    eintraege,
  );
  let aktiv = 0;

  const gewaehlt = () => feldSelect.selectedIndex;
  const zeigeWahl = () => {
    const wahl = optionen[gewaehlt()];
    text.replaceChildren(...(wahl ? inhalt(wahl).childNodes : []));
    eintraege.forEach((e, i) =>
      e.setAttribute("aria-selected", String(i === gewaehlt())),
    );
  };
  const markiere = (i) => {
    aktiv = Math.max(0, Math.min(eintraege.length - 1, i));
    eintraege.forEach((e, j) => e.classList.toggle("ist-aktiv", j === aktiv));
    knopf.setAttribute("aria-activedescendant", eintraege[aktiv].id);
    eintraege[aktiv].scrollIntoView({ block: "nearest" });
  };
  const offen = () => liste.matches(":popover-open");
  // Die Liste liegt im Top-Layer und ragt so über das Dialogfenster hinaus; Lage und Breite folgen dem Knopf
  const platziere = () => {
    const r = knopf.getBoundingClientRect();
    liste.style.top = `${r.bottom + 4}px`;
    liste.style.left = `${r.left}px`;
    liste.style.width = `${r.width}px`;
  };
  // Scrollt oder wächst das Fenster, stimmt die Lage nicht mehr: schliessen statt nachführen
  const beiLageAenderung = (e) => {
    if (e.target !== liste) schliesse();
  };
  const oeffne = () => {
    platziere();
    liste.showPopover();
    window.addEventListener("resize", beiLageAenderung);
    document.addEventListener("scroll", beiLageAenderung, true);
    knopf.setAttribute("aria-expanded", "true");
    markiere(gewaehlt());
  };
  const schliesse = () => {
    if (offen()) liste.hidePopover();
    window.removeEventListener("resize", beiLageAenderung);
    document.removeEventListener("scroll", beiLageAenderung, true);
    knopf.setAttribute("aria-expanded", "false");
    knopf.removeAttribute("aria-activedescendant");
  };
  const waehle = (i) => {
    if (i !== gewaehlt()) {
      feldSelect.selectedIndex = i;
      zeigeWahl();
      feldSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    schliesse();
  };

  knopf.addEventListener("click", () => (offen() ? schliesse() : oeffne()));
  knopf.addEventListener("blur", schliesse);
  knopf.addEventListener("keydown", (e) => {
    const taste = e.key;
    if (taste === "Tab") return schliesse();
    if (taste === "Escape") {
      if (!offen()) return;
      e.preventDefault();
      e.stopPropagation();
      return schliesse();
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(taste)) {
      e.preventDefault();
      if (!offen()) return oeffne();
      if (taste === "ArrowDown") markiere(aktiv + 1);
      else if (taste === "ArrowUp") markiere(aktiv - 1);
      else markiere(taste === "Home" ? 0 : eintraege.length - 1);
    } else if (taste === "Enter" || taste === " ") {
      e.preventDefault();
      if (offen()) waehle(aktiv);
      else oeffne();
    } else if (taste.length === 1 && !e.ctrlKey && !e.metaKey) {
      // Kurzwahl: nächster Eintrag, der mit dem Buchstaben beginnt
      const start = (offen() ? aktiv : gewaehlt()) + 1;
      const n = optionen.length;
      for (let k = 0; k < n; k++) {
        const i = (start + k) % n;
        if (optionen[i][1].toLowerCase().startsWith(taste.toLowerCase())) {
          (offen() ? markiere : waehle)(i);
          break;
        }
      }
    }
  });
  // mousedown nicht übernehmen, sonst verliert der Knopf den Fokus und die Liste schliesst vor dem Klick
  liste.addEventListener("mousedown", (e) => e.preventDefault());
  liste.addEventListener("click", (e) => {
    const i = eintraege.indexOf(e.target.closest("li"));
    if (i >= 0) waehle(i);
  });
  zeigeWahl();
  return {
    wurzel: el(
      "div",
      { class: "feld" },
      el("label", { for: id, id: `${id}-label` }, label),
      el("div", { class: "auswahl" }, knopf, liste, feldSelect),
    ),
    eingabe: feldSelect,
  };
}

export function ankreuzen({ label, gewaehlt = false, wert }) {
  const id = neueId("wahl");
  const eingabe = el("input", { id, type: "checkbox", value: wert });
  eingabe.checked = gewaehlt;
  return {
    wurzel: el(
      "div",
      { class: "wahl" },
      eingabe,
      el("label", { for: id }, label),
    ),
    eingabe,
  };
}

export function gruppe(legende, inhalt, { scrollen = false } = {}) {
  return el(
    "fieldset",
    { class: scrollen ? "scrollfeld" : undefined },
    el("legend", {}, legende),
    inhalt,
  );
}

// Leere Pflichtfelder bekommen die Meldung direkt unter dem Feld (nicht nur Farbe) und den Fokus; true, wenn eines fehlt
function pruefePflichtfelder(formular) {
  let erstes = null;
  for (const eingabe of formular.querySelectorAll(
    "input[required], textarea[required]",
  )) {
    const wurzel = eingabe.closest(".feld");
    wurzel?.querySelector(".feld-fehler")?.remove();
    eingabe.removeAttribute("aria-invalid");
    if (eingabe.value.trim() !== "") continue;
    const meldung = el(
      "p",
      { class: "feld-fehler", id: `${eingabe.id}-fehler`, role: "alert" },
      "Bitte ausfüllen.",
    );
    wurzel?.append(meldung);
    eingabe.setAttribute("aria-invalid", "true");
    eingabe.setAttribute(
      "aria-describedby",
      [eingabe.getAttribute("aria-describedby"), meldung.id]
        .filter(Boolean)
        .join(" "),
    );
    eingabe.addEventListener(
      "input",
      () => {
        eingabe.removeAttribute("aria-invalid");
        meldung.remove();
      },
      { once: true },
    );
    erstes ??= eingabe;
  }
  erstes?.focus();
  return erstes !== null;
}

// Liefert den Dialog-Inhalt in der Reihenfolge: Titel, Beschreibung, Felder, Fehler, Knöpfe
// senden() darf werfen; die Meldung erscheint im Dialog, er bleibt offen
export function dialogFormular({
  titel,
  beschreibung,
  felder = [],
  ok,
  gefaehrlich = false,
  senden,
  danach,
  fehlertext = standardFehlertext,
}) {
  const zurueck = ausloeser();
  const titelId = neueId("titel");
  const fehler = el("p", {
    class: "hinweis hinweis--fehler",
    role: "alert",
    hidden: true,
    tabindex: "-1",
  });
  const abbrechen = knopf("Abbrechen", { onclick: () => dialog.close() });
  const bestaetigen = el(
    "button",
    {
      type: "submit",
      class: gefaehrlich ? "knopf knopf--gefahr" : "knopf knopf--haupt",
    },
    ok,
  );
  const formular = el(
    "form",
    { class: "formular", novalidate: true },
    ...felder,
    fehler,
    el("div", { class: "dialog-knoepfe" }, abbrechen, bestaetigen),
  );
  const ueberschrift = el("h2", { id: titelId, tabindex: "-1" }, titel);
  const dialog = el(
    "dialog",
    { "aria-labelledby": titelId },
    ueberschrift,
    beschreibung && el("p", { class: "beschreibung" }, beschreibung),
    formular,
  );
  formular.addEventListener("submit", async (ereignis) => {
    ereignis.preventDefault();
    fehler.hidden = true;
    if (pruefePflichtfelder(formular)) return;
    abbrechen.disabled = bestaetigen.disabled = true;
    try {
      const ergebnis = await senden();
      dialog.close();
      danach?.(ergebnis);
    } catch (f) {
      fehler.textContent = fehlertext(f);
      fehler.hidden = false;
      fehler.focus();
    } finally {
      abbrechen.disabled = bestaetigen.disabled = false;
    }
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    // Folgt gleich ein weiterer Dialog (Startpasswort), gehört ihm der Fokus
    const offen = document.querySelector("dialog[open]");
    if (offen && !offen.contains(zurueck)) return;
    // Zurück zum Auslöser; ist er nach dem Neuladen weg, bleibt der Fokus beim Titel der Seite
    if (zurueck?.isConnected) zurueck.focus();
    else document.querySelector("h1")?.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  // Zerstörende Dialoge starten bei «Abbrechen», die anderen im ersten Feld
  const erstes = dialog.querySelector("input, .auswahl-knopf, textarea");
  (gefaehrlich || !erstes ? abbrechen : erstes).focus();
  return dialog;
}

// Modales Seitenblatt von rechts für Details und Bearbeiten; Fokus, Escape und Rückfokus wie bei dialogFormular
// inhalt und fusszeile: Knoten oder Listen davon; schliessen() läuft nach dem Schliessen. Liefert das dialog-Element (dialog.close() schliesst es).
export function seitenblatt({
  titel,
  untertitel,
  inhalt,
  fusszeile,
  schliessen,
}) {
  const zurueck = ausloeser();
  const titelId = neueId("titel");
  const ueberschrift = el("h2", { id: titelId, tabindex: "-1" }, titel);
  const zu = el(
    "button",
    {
      type: "button",
      class: "knopf knopf--rund",
      "aria-label": "Schliessen",
      onclick: () => dialog.close(),
    },
    icon("schliessen"),
  );
  const dialog = el(
    "dialog",
    { class: "blatt", "aria-labelledby": titelId },
    el(
      "div",
      { class: "blatt-kopf" },
      el(
        "div",
        { class: "blatt-titel" },
        ueberschrift,
        untertitel && el("p", { class: "leise" }, untertitel),
      ),
      zu,
    ),
    el("div", { class: "blatt-inhalt" }, inhalt),
    fusszeile && el("div", { class: "blatt-fuss" }, fusszeile),
  );
  // Klick auf den abgedunkelten Rest schliesst das Blatt
  dialog.addEventListener("click", (ereignis) => {
    if (ereignis.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    schliessen?.();
    const offen = document.querySelector("dialog[open]");
    if (offen && !offen.contains(zurueck)) return;
    if (zurueck?.isConnected) zurueck.focus();
    else document.querySelector("h1")?.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  const erstes = dialog.querySelector(
    ".blatt-inhalt input, .blatt-inhalt .auswahl-knopf, .blatt-inhalt textarea",
  );
  (erstes ?? ueberschrift).focus();
  return dialog;
}

// Rückfrage vor einer folgenreichen Aktion; aktion() wirft bei Fehlern, danach() läuft nach dem Schliessen
export function bestaetigen({
  titel,
  beschreibung,
  ok,
  aktion,
  danach,
  gefaehrlich = true,
}) {
  return dialogFormular({
    titel,
    beschreibung,
    ok,
    gefaehrlich,
    senden: aktion,
    danach,
  });
}

// Zeigt ein Geheimnis (Startpasswort) genau einmal; beim Schliessen wird der Text aus der Seite gelöscht
// wert: ein Text, oder eintraege: [{ label, wert }, …] für mehrere Geheimnisse (z. B. mehrere neue Konten)
export function geheimnisDialog({ titel, beschreibung, wert, eintraege }) {
  const zurueck = ausloeser();
  const titelId = neueId("titel");
  const liste = eintraege ?? [{ wert }];
  const rueck = el("p", { class: "hilfe", role: "status" });
  const anzeigen = [];
  const bloecke = liste.map((e) => {
    // Ein Absatz statt <output>: Das hätte die Rolle «status» und sagte das Passwort ungefragt an
    const anzeige = el("p", { class: "geheimnis" }, e.wert);
    anzeigen.push(anzeige);
    const kopieren = knopf("Kopieren", {
      symbol: "kopieren",
      kontext: e.label,
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(e.wert);
          rueck.textContent = "Kopiert.";
        } catch {
          rueck.textContent =
            "Kopieren ist nicht möglich. Markiere das Passwort von Hand.";
        }
      },
    });
    return el(
      "div",
      { class: "geheimnis-block" },
      e.label && el("p", { class: "fett" }, e.label),
      anzeige,
      kopieren,
    );
  });
  const schliessen = el(
    "button",
    {
      type: "button",
      class: "knopf knopf--haupt",
      onclick: () => dialog.close(),
    },
    "Schliessen",
  );
  const dialog = el(
    "dialog",
    { "aria-labelledby": titelId },
    el("h2", { id: titelId, tabindex: "-1" }, titel),
    el("p", { class: "beschreibung" }, beschreibung),
    bloecke,
    rueck,
    el("div", { class: "dialog-knoepfe" }, schliessen),
  );
  dialog.addEventListener("close", () => {
    for (const anzeige of anzeigen) anzeige.textContent = "";
    dialog.remove();
    if (zurueck?.isConnected) zurueck.focus();
    else document.querySelector("h1")?.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  bloecke[0].querySelector("button").focus();
}
