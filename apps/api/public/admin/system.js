import { anfrage, fehlertext } from "./api.js";
import { aenderungenTafel, syncTafel } from "./aenderungen.js";
import {
  auswahl,
  chip,
  el,
  filterGruppe,
  icon,
  knopf,
  neueId,
  tabelle,
  zeit,
} from "./dom.js";

// Betriebszahlen der API: Seite «System» und Bausteine für die «Übersicht». Alles kommt als Zahl oder fester Text von /api/v1/admin/system*; Anfragen werden nur im Arbeitsspeicher der API gezählt und beginnen nach jedem Neustart bei null.

const ZAHL = new Intl.NumberFormat("de-CH");
const PROZENT = new Intl.NumberFormat("de-CH", {
  style: "percent",
  maximumFractionDigits: 1,
});
const UHR = new Intl.DateTimeFormat("de-CH", {
  hour: "2-digit",
  minute: "2-digit",
});
const UHR_SEKUNDEN = new Intl.DateTimeFormat("de-CH", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const STUNDE = new Intl.DateTimeFormat("de-CH", {
  weekday: "short",
  hour: "2-digit",
});
const RELATIV = new Intl.RelativeTimeFormat("de-CH", { numeric: "auto" });

export const zahl = (n) =>
  n === null || n === undefined ? "–" : ZAHL.format(n);
export const prozent = (n) => PROZENT.format(n);
export const ms = (n) =>
  n === null || n === undefined ? "–" : `${ZAHL.format(n)} ms`;

export function dauer(sekunden) {
  const t = Math.floor(sekunden / 86400);
  const h = Math.floor((sekunden % 86400) / 3600);
  const m = Math.floor((sekunden % 3600) / 60);
  if (t > 0) return `${t} Tg. ${h} Std.`;
  if (h > 0) return `${h} Std. ${m} Min.`;
  if (m > 0) return `${m} Min.`;
  return `${sekunden} Sek.`;
}

// «vor 3 Minuten»; das Datum steht zusätzlich im Titel des Elements
export function vor(iso) {
  const sekunden = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const abs = Math.abs(sekunden);
  if (abs < 60) return RELATIV.format(Math.round(sekunden / 10) * 10, "second");
  if (abs < 3600) return RELATIV.format(Math.round(sekunden / 60), "minute");
  if (abs < 86400) return RELATIV.format(Math.round(sekunden / 3600), "hour");
  return RELATIV.format(Math.round(sekunden / 86400), "day");
}

export async function ladeBetrieb() {
  const [system, anfragen] = await Promise.all([
    anfrage("GET", "/api/v1/admin/system"),
    anfrage("GET", "/api/v1/admin/system/requests"),
  ]);
  return { system, anfragen };
}

// Lädt alle 15 Sekunden neu, solange der Bereich auf der Seite steht und der Reiter sichtbar ist; ein Fehler lässt die alten Zahlen stehen
export function laufend(bereich, laden, zeichnen, fehlerFeld, sekunden = 15) {
  let laeuft = false;
  async function lauf() {
    if (laeuft || document.hidden) return false;
    laeuft = true;
    try {
      zeichnen(await laden());
      fehlerFeld.textContent = "";
      return true;
    } catch (f) {
      if (bereich.isConnected) {
        fehlerFeld.textContent = `Aktualisieren nicht möglich: ${fehlertext(f)}`;
      }
      return false;
    } finally {
      laeuft = false;
    }
  }
  const takt = setInterval(() => {
    if (!bereich.isConnected) stoppe();
    else lauf();
  }, sekunden * 1000);
  const sichtbar = () => {
    if (!document.hidden && bereich.isConnected) lauf();
  };
  function stoppe() {
    clearInterval(takt);
    document.removeEventListener("visibilitychange", sichtbar);
  }
  document.addEventListener("visibilitychange", sichtbar);
  // Für «Aktualisieren» von Hand: liefert, ob es geklappt hat
  return lauf;
}

// Beim Neuzeichnen bleibt der Fokus auf dem Element mit demselben data-fokus, sonst verlöre ihn die Tastatur alle 15 Sekunden
function ersetze(behaelter, ...knoten) {
  const aktiv = behaelter.contains(document.activeElement)
    ? document.activeElement.dataset?.fokus
    : undefined;
  behaelter.replaceChildren(...knoten);
  if (aktiv) {
    [...behaelter.querySelectorAll("[data-fokus]")]
      .find((k) => k.dataset.fokus === aktiv)
      ?.focus({ preventScroll: true });
  }
}

// Text nur bei Änderung setzen: Live-Regionen sagen sonst jede Aktualisierung an
function setzeText(knoten, text) {
  if (knoten.textContent !== text) knoten.textContent = text;
}

// Zustand steht immer auch als Wort im Text, nie nur als Farbe oder Symbol
// zustand: Wort im Chip oben rechts (mit status auch Symbol); ohne zustand zeigt das CSS nur ein Symbol
export function kachel({ titel, wert, hinweis, status, zustand, link, text }) {
  const titelKnoten = el("p", { class: "kachel-titel" }, titel);
  return el(
    "div",
    {
      class: [
        "kachel",
        status && `kachel--${status}`,
        zustand && "kachel--chip",
      ]
        .filter(Boolean)
        .join(" "),
    },
    zustand
      ? el(
          "div",
          { class: "kachel-kopf" },
          titelKnoten,
          el(
            "ul",
            { class: "chips" },
            chip(zustand, status, status ? undefined : "info"),
          ),
        )
      : titelKnoten,
    el(
      "p",
      { class: text ? "kachel-wert kachel-wert--text" : "kachel-wert" },
      wert,
    ),
    hinweis && el("p", { class: "kachel-hinweis" }, hinweis),
    link,
  );
}

export function panel(titel, ...inhalt) {
  return el("section", { class: "panel" }, el("h2", {}, titel), ...inhalt);
}

// Zeilen aus Name und Wert; wert darf Text oder Knoten sein
export function werte(zeilen) {
  return el(
    "dl",
    { class: "werte" },
    zeilen
      .filter(Boolean)
      .map(([name, wert]) =>
        el("div", {}, el("dt", {}, name), el("dd", {}, wert)),
      ),
  );
}

// Der Namensraum von SVG ist eine Kennung, keine Adresse: Es wird nichts geladen
const SVG = "http://www.w3.org/2000/svg";
function svg(tag, eigenschaften = {}, ...kinder) {
  const knoten = document.createElementNS(SVG, tag);
  for (const [name, wert] of Object.entries(eigenschaften)) {
    knoten.setAttribute(name, String(wert));
  }
  knoten.append(...kinder.flat(Infinity));
  return knoten;
}

// Gestapelte Balken je Zeitraum: in Ordnung, 4xx, 5xx. Die Farben tragen zusätzlich Muster (4xx Streifen, 5xx Punkte), die Legende zeigt dieselben. Die Tabelle dahinter enthält dieselben Zahlen.
export function diagramm({ titel, punkte, beschriftung, einheit, offen }) {
  const B = 720;
  const H = 160;
  const max = Math.max(1, ...punkte.map((p) => p.anzahl));
  const schritt = B / punkte.length;
  const breite = Math.max(2, schritt * 0.72);
  const gesamt = punkte.reduce((a, p) => a + p.anzahl, 0);
  const spitze = punkte.reduce(
    (a, p) => (p.anzahl > a.anzahl ? p : a),
    punkte[0],
  );
  // Die Muster-IDs müssen je Diagramm eindeutig sein, auf einer Seite stehen mehrere
  const musterId = neueId("muster");
  const muster = svg(
    "defs",
    {},
    svg(
      "pattern",
      {
        id: `${musterId}-4xx`,
        width: 6,
        height: 6,
        patternUnits: "userSpaceOnUse",
        patternTransform: "rotate(45)",
      },
      svg("line", {
        class: "muster-linie",
        x1: 1.5,
        y1: 0,
        x2: 1.5,
        y2: 6,
        "stroke-width": 3,
      }),
    ),
    svg(
      "pattern",
      {
        id: `${musterId}-5xx`,
        width: 6,
        height: 6,
        patternUnits: "userSpaceOnUse",
      },
      svg("circle", { class: "muster-punkt", cx: 3, cy: 3, r: 1.6 }),
    ),
  );
  const balken = punkte.map((p, i) => {
    const x = i * schritt + (schritt - breite) / 2;
    const teile = [
      ["bal--ok", p.anzahl - p.fehler4xx - p.fehler5xx, null],
      ["bal--4xx", p.fehler4xx, `${musterId}-4xx`],
      ["bal--5xx", p.fehler5xx, `${musterId}-5xx`],
    ];
    let unten = H;
    return svg(
      "g",
      {},
      svg(
        "title",
        {},
        `${beschriftung(p.ab)}: ${zahl(p.anzahl)} Anfragen, davon ${zahl(p.fehler4xx)} mit 4xx und ${zahl(p.fehler5xx)} mit 5xx`,
      ),
      // Unsichtbare Fläche über die ganze Höhe, damit auch ein kleiner Balken den Hinweis zeigt
      svg("rect", { class: "bal--flaeche", x, y: 0, width: breite, height: H }),
      teile
        .filter(([, n]) => n > 0)
        .map(([klasse, n, musterName]) => {
          const h = Math.max(1.5, (n / max) * (H - 4));
          unten -= h;
          const form = { x, y: unten, width: breite, height: h, rx: 1 };
          return [
            svg("rect", { class: klasse, ...form }),
            musterName &&
              svg("rect", {
                ...form,
                class: "bal--muster",
                fill: `url(#${musterName})`,
              }),
          ].filter(Boolean);
        }),
    );
  });
  const gitter = [0, 0.5, 1].map((anteil) =>
    svg("line", {
      class: "gitter",
      x1: 0,
      x2: B,
      y1: H - anteil * (H - 4),
      y2: H - anteil * (H - 4),
    }),
  );
  const grafik = svg(
    "svg",
    {
      viewBox: `0 0 ${B} ${H}`,
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": `${titel}: ${zahl(gesamt)} Anfragen insgesamt, Spitze ${zahl(spitze.anzahl)} ${einheit} (${beschriftung(spitze.ab)}).`,
    },
    muster,
    gitter,
    balken,
  );
  const zeilen = tabelle({
    beschriftung: `${titel} als Tabelle`,
    spalten: [
      "Zeitraum",
      ["Anfragen", "zahl"],
      ["davon 4xx", "zahl"],
      ["davon 5xx", "zahl"],
    ],
    zeilen: [...punkte]
      .reverse()
      .map((p) =>
        el(
          "tr",
          {},
          el("th", { scope: "row" }, beschriftung(p.ab)),
          el("td", { class: "zahl" }, zahl(p.anzahl)),
          el("td", { class: "zahl" }, zahl(p.fehler4xx)),
          el("td", { class: "zahl" }, zahl(p.fehler5xx)),
        ),
      ),
  });
  zeilen.wurzel.dataset.fokus = "diagramm-rahmen";
  const alternative = el(
    "details",
    { class: "diagramm-tabelle", open: offen.wert },
    el("summary", { "data-fokus": "diagramm-tabelle" }, "Als Tabelle anzeigen"),
    zeilen.wurzel,
  );
  alternative.addEventListener("toggle", () => {
    offen.wert = alternative.open;
  });
  return el(
    "figure",
    { class: "diagramm" },
    el(
      "div",
      { class: "diagramm-achse" },
      el("span", {}, `Höchstwert ${zahl(max)} pro ${einheit}`),
      el(
        "ul",
        { class: "legende" },
        el("li", { class: "legende--ok" }, "In Ordnung"),
        el("li", { class: "legende--4xx" }, "4xx"),
        el("li", { class: "legende--5xx" }, "5xx"),
      ),
    ),
    grafik,
    el(
      "div",
      { class: "diagramm-achse diagramm-achse--unten" },
      el("span", {}, beschriftung(punkte[0].ab)),
      el("span", {}, "jetzt"),
    ),
    alternative,
  );
}

export const stundenName = (iso) => STUNDE.format(new Date(iso));
export const minutenName = (iso) => UHR.format(new Date(iso));

export function fehlerTabelle(fehler, max = fehler.length) {
  const gezeigt = fehler.slice(0, max);
  if (fehler.length === 0) {
    return el(
      "p",
      { class: "leer leer--klein" },
      icon("haken"),
      " Keine Fehler seit dem Start.",
    );
  }
  const rahmen = tabelle({
    beschriftung: "Letzte Fehler",
    spalten: ["Zeit", "Status", "Methode", "Route"],
    zeilen: gezeigt.map((f) =>
      el(
        "tr",
        {},
        el("th", { scope: "row" }, UHR_SEKUNDEN.format(new Date(f.zeit))),
        el(
          "td",
          {},
          el(
            "ul",
            { class: "chips" },
            chip(String(f.status), f.status >= 500 ? "fehler" : "warn"),
          ),
        ),
        el("td", { class: "mono" }, f.methode),
        el("td", { class: "mono" }, f.route),
      ),
    ),
  }).wurzel;
  rahmen.dataset.fokus = "fehler-rahmen";
  return rahmen;
}

export function hinweisSeitStart(anfragen) {
  return `Die Zahlen zu den Anfragen liegen im Arbeitsspeicher der API und beginnen nach jedem Neustart bei null. Seit dem Start am ${zeit(anfragen.seit)}.`;
}

const SORTIERUNG = [
  ["anzahl", "Häufigste zuerst"],
  ["p95Ms", "Langsamste zuerst (95 %)"],
  ["fehler", "Meiste Fehler zuerst"],
];
const fehlerzahl = (r) => r.fehler4xx + r.fehler5xx;
const wertFuer = {
  anzahl: (r) => r.anzahl,
  p95Ms: (r) => r.p95Ms ?? -1,
  fehler: fehlerzahl,
};
const STATUS_FILTER = [
  { text: "Alle", wert: "alle" },
  { text: "Mit 4xx", wert: "4xx" },
  { text: "Mit 5xx", wert: "5xx" },
];
const ZEITRAEUME = [
  ["minuten", "Letzte Stunde"],
  ["stunden", "Letzte 24 Stunden"],
];

export function zeige(bereich, ctx) {
  ctx.lade(ladeBetrieb, (daten) => zeichneSeite(bereich, daten, ctx));
}

// Reiter innerhalb der Seite (ein Hash je Bereich): Pfeiltasten wechseln und aktivieren, Tab geht in den Inhalt
function reiter(beschriftung, eintraege) {
  const knoepfe = eintraege.map((e) =>
    el(
      "button",
      {
        type: "button",
        class: "tab",
        role: "tab",
        id: `${e.id}-reiter`,
        "aria-controls": e.id,
        onclick: () => waehle(e.id),
      },
      e.text,
    ),
  );
  const tafeln = eintraege.map((e) =>
    el(
      "div",
      {
        class: "system-tafel",
        role: "tabpanel",
        id: e.id,
        "aria-labelledby": `${e.id}-reiter`,
      },
      e.inhalt,
    ),
  );
  function waehle(id, fokus = true) {
    eintraege.forEach((e, i) => {
      const aktiv = e.id === id;
      knoepfe[i].setAttribute("aria-selected", String(aktiv));
      knoepfe[i].tabIndex = aktiv ? 0 : -1;
      tafeln[i].hidden = !aktiv;
      if (aktiv && fokus) knoepfe[i].focus();
    });
  }
  const leiste = el(
    "div",
    { class: "tabs", role: "tablist", "aria-label": beschriftung },
    knoepfe,
  );
  leiste.addEventListener("keydown", (ereignis) => {
    const i = knoepfe.indexOf(document.activeElement);
    const ziel = {
      ArrowRight: (i + 1) % knoepfe.length,
      ArrowLeft: (i - 1 + knoepfe.length) % knoepfe.length,
      Home: 0,
      End: knoepfe.length - 1,
    }[ereignis.key];
    if (i < 0 || ziel === undefined) return;
    ereignis.preventDefault();
    waehle(eintraege[ziel].id);
  });
  waehle(eintraege[0].id, false);
  return { leiste, tafeln, waehle };
}

// Eine Zeile zur Lage; der Zustand steht im Wort, die Farbe und das Symbol (aus dem CSS) verstärken nur
function lage(s, a) {
  const probleme = [];
  if (!s.datenbank.erreichbar) {
    probleme.push(["fehler", "Die Datenbank ist nicht erreichbar."]);
  }
  if (a.quote5xx > 0.01) {
    probleme.push([
      "warn",
      `${prozent(a.quote5xx)} der Anfragen enden mit einem Serverfehler (5xx).`,
    ]);
  }
  if (probleme.length === 0) {
    return [
      "ok",
      "Alles läuft: Datenbank erreichbar, keine auffälligen Fehler.",
    ];
  }
  return [
    probleme.some(([art]) => art === "fehler") ? "fehler" : "warn",
    probleme.map(([, text]) => text).join(" "),
  ];
}

function systemKacheln(s, a) {
  const p = s.prozess;
  const d = s.datenbank;
  return [
    kachel({
      titel: "API",
      wert: `Node ${p.node}`,
      text: true,
      status: "ok",
      zustand: "Läuft",
      hinweis: `Gestartet ${zeit(p.gestartetAm)}, Laufzeit ${dauer(p.laufzeitSekunden)}`,
    }),
    kachel({
      titel: "Datenbank",
      wert: d.pingMs === null ? "–" : ms(d.pingMs),
      status: d.erreichbar ? "ok" : "fehler",
      zustand: d.erreichbar ? "Erreichbar" : "Nicht erreichbar",
      hinweis: "Antwortzeit der Abfrage",
    }),
    kachel({
      titel: "Push-Tokens",
      wert: zahl(s.bestand.pushTokens),
      hinweis: "Registrierte Geräte",
    }),
    kachel({
      titel: "Anfragen (24 Std.)",
      wert: zahl(a.gesamt),
      hinweis: `${zahl(a.statusklassen["4xx"])} mit 4xx · ${zahl(a.statusklassen["5xx"])} mit 5xx`,
    }),
  ];
}

function systemPanels(s) {
  const p = s.prozess;
  const d = s.datenbank;
  const ja = (b) => (b ? "Ja" : "Nein");
  return [
    panel(
      "Prozess",
      werte([
        ["Node", p.node],
        ["Commit", p.commit ?? "nicht gesetzt"],
        ["Gestartet", zeit(p.gestartetAm)],
        ["Laufzeit", dauer(p.laufzeitSekunden)],
        ["Speicher (RSS)", `${ZAHL.format(p.rssMb)} MB`],
        [
          "Heap genutzt / gesamt",
          `${ZAHL.format(p.heapGenutztMb)} / ${ZAHL.format(p.heapGesamtMb)} MB`,
        ],
        [
          "Ereignisschleife (p99)",
          p.schleifeP99Ms === null ? "–" : `${ZAHL.format(p.schleifeP99Ms)} ms`,
        ],
      ]),
    ),
    panel(
      "Datenbank",
      werte([
        [
          "Zustand",
          el(
            "ul",
            { class: "chips" },
            chip(
              d.erreichbar ? "Erreichbar" : "Nicht erreichbar",
              d.erreichbar ? "ok" : "fehler",
            ),
          ),
        ],
        [
          "Antwortzeit",
          d.pingMs === null ? "–" : `${ZAHL.format(d.pingMs)} ms`,
        ],
        [
          "Verbindungen",
          d.verbindungen === null
            ? "–"
            : `${zahl(d.verbindungen)} (alle Anwendungen)`,
        ],
        ["Pool der API", `höchstens ${zahl(d.poolMaximum)}`],
      ]),
    ),
    panel(
      "Umgebung",
      werte([
        ["HTTPS", ja(s.umgebung.https)],
        ["Produktion", ja(s.umgebung.produktion)],
      ]),
    ),
  ];
}

// Aufklappbarer Teil einer Route: ihre Fehler unter den letzten Fehlern, neueste zuerst
function routenDetail(r, fehler) {
  const eigene = fehler.filter(
    (f) => f.methode === r.methode && f.route === r.route,
  );
  return el(
    "div",
    { class: "route-detail" },
    el(
      "p",
      { class: "klein leise" },
      eigene.length === 0
        ? "Keine Fehler dieser Route unter den letzten Fehlern."
        : "Letzte Fehler dieser Route (Zeit, Status):",
    ),
    eigene.length > 0 &&
      el(
        "pre",
        { class: "stack mono" },
        eigene
          .map((f) => `${UHR_SEKUNDEN.format(new Date(f.zeit))}  ${f.status}`)
          .join("\n"),
      ),
    el(
      "p",
      { class: "hilfe" },
      "p50 und p95 sind die Obergrenze der Dauerklasse, in der das Quantil liegt.",
    ),
  );
}

function zeichneSeite(bereich, daten, ctx) {
  let anfragen;
  let sortierung = "anzahl";
  let statusFilter = "alle";
  let zeitraum = "minuten";
  let suche = "";
  const offeneRouten = new Set();
  const offen = { wert: false };
  const basis = neueId("system");
  // Nur ein Fehler wird angesagt; die regelmässige Aktualisierung bleibt still
  const fehlerFeld = el("p", { class: "meta fehlerzeile", role: "status" });
  const stand = el("p", { class: "meta stand" });
  const lageFeld = el("div", { class: "hinweis", role: "status" });
  const kacheln = el("div", { class: "kacheln" });
  const kurzFehler = el("div", {});
  const panels = el("div", { class: "raster raster--2" });
  const hinweisStart = el("p", { class: "hinweis" });
  const anfragenKachelnFeld = el("div", { class: "kacheln" });
  const verlauf = el("div", {});
  const verlaufTitel = el("h2", {});
  const routen = el("div", {});
  const routenZahl = el("p", { class: "klein leise", role: "status" });
  const fehler = el("div", {});

  const sortieren = auswahl({
    label: "Sortieren",
    optionen: SORTIERUNG,
    wert: sortierung,
  });
  const zeitraumWahl = auswahl({
    label: "Zeitraum",
    optionen: ZEITRAEUME,
    wert: zeitraum,
  });
  const statusWahl = filterGruppe({
    beschriftung: "Status",
    eintraege: STATUS_FILTER,
    wert: statusFilter,
    beiAenderung: (wert) => {
      statusFilter = wert;
      zeichneRouten();
    },
  });
  const sucheId = neueId("suche");
  const sucheFeld = el("input", {
    id: sucheId,
    class: "eingabe",
    type: "search",
    placeholder: "Route oder Methode",
    autocomplete: "off",
  });

  function zeichneVerlauf() {
    const stunden = zeitraum === "stunden";
    verlaufTitel.textContent = stunden
      ? "Anfragen pro Stunde"
      : "Anfragen pro Minute";
    ersetze(
      verlauf,
      diagramm({
        titel: stunden
          ? "Anfragen pro Stunde, letzte 24 Stunden"
          : "Anfragen pro Minute, letzte Stunde",
        punkte: stunden ? anfragen.stunden : anfragen.minuten,
        beschriftung: stunden ? stundenName : minutenName,
        einheit: stunden ? "Stunde" : "Minute",
        offen,
      }),
    );
  }

  function zeichneRouten() {
    const suchtext = suche.trim().toLowerCase();
    const zeilen = anfragen.routen
      .filter(
        (r) =>
          (statusFilter === "alle" ||
            (statusFilter === "4xx" ? r.fehler4xx : r.fehler5xx) > 0) &&
          `${r.methode} ${r.route}`.toLowerCase().includes(suchtext),
      )
      .sort((a, b) => wertFuer[sortierung](b) - wertFuer[sortierung](a));
    setzeText(
      routenZahl,
      zeilen.length === anfragen.routen.length
        ? `${zahl(zeilen.length)} Routen`
        : `${zahl(zeilen.length)} von ${zahl(anfragen.routen.length)} Routen`,
    );
    if (zeilen.length === 0) {
      ersetze(
        routen,
        el(
          "p",
          { class: "leer leer--klein" },
          anfragen.routen.length === 0
            ? "Noch keine Anfragen seit dem Start."
            : "Keine Route passt zu Suche und Filter.",
        ),
      );
      return;
    }
    const tabelleRouten = tabelle({
      beschriftung: "Anfragen je Route",
      spalten: [
        "Methode",
        "Route",
        ["Anzahl", "zahl"],
        ["4xx", "zahl"],
        ["5xx", "zahl"],
        ["Fehlerquote", "zahl"],
        ["p50", "zahl"],
        ["p95", "zahl"],
        [el("span", { class: "nur-leser" }, "Details"), "rechts"],
      ],
      zeilen: zeilen.flatMap((r, i) => {
        const schluessel = `${r.methode} ${r.route}`;
        const aufgeklappt = offeneRouten.has(schluessel);
        const detailId = `${basis}-detail-${i}`;
        const zeile = el(
          "tr",
          {},
          el(
            "th",
            { scope: "row" },
            r.methode ? el("ul", { class: "chips" }, chip(r.methode)) : "–",
          ),
          el("td", { class: "mono" }, r.route),
          el("td", { class: "zahl" }, zahl(r.anzahl)),
          el("td", { class: "zahl" }, zahl(r.fehler4xx)),
          el("td", { class: "zahl" }, zahl(r.fehler5xx)),
          el("td", { class: "zahl" }, prozent(fehlerzahl(r) / r.anzahl)),
          el("td", { class: "zahl" }, ms(r.p50Ms)),
          el("td", { class: "zahl" }, ms(r.p95Ms)),
          el(
            "td",
            { class: "rechts" },
            el(
              "button",
              {
                type: "button",
                class: "knopf knopf--rund",
                "data-fokus": schluessel,
                "aria-label": `Details: ${schluessel}`,
                "aria-expanded": String(aufgeklappt),
                "aria-controls": aufgeklappt ? detailId : undefined,
                onclick: () => {
                  if (aufgeklappt) offeneRouten.delete(schluessel);
                  else offeneRouten.add(schluessel);
                  zeichneRouten();
                },
              },
              icon(aufgeklappt ? "schliessen" : "plus"),
            ),
          ),
        );
        return aufgeklappt
          ? [
              zeile,
              el(
                "tr",
                { class: "offen", id: detailId },
                el(
                  "td",
                  { colspan: "9" },
                  routenDetail(r, anfragen.letzteFehler),
                ),
              ),
            ]
          : [zeile];
      }),
    });
    tabelleRouten.wurzel.dataset.fokus = "routen-rahmen";
    ersetze(routen, tabelleRouten.wurzel);
  }

  const zeichne = ({ system: s, anfragen: a }) => {
    anfragen = a;
    setzeText(
      stand,
      `Stand ${UHR_SEKUNDEN.format(new Date())}, wird alle 15 Sekunden aktualisiert.`,
    );
    const [art, text] = lage(s, a);
    lageFeld.className = `hinweis hinweis--${art}`;
    setzeText(lageFeld, text);
    ersetze(kacheln, ...systemKacheln(s, a));
    ersetze(kurzFehler, fehlerTabelle(a.letzteFehler, 8));
    ersetze(panels, ...systemPanels(s));
    setzeText(hinweisStart, hinweisSeitStart(a));
    ersetze(anfragenKachelnFeld, ...anfragenKacheln(a));
    zeichneVerlauf();
    zeichneRouten();
    ersetze(fehler, fehlerTabelle(a.letzteFehler, 15));
  };

  sortieren.eingabe.addEventListener("change", () => {
    sortierung = sortieren.eingabe.value;
    zeichneRouten();
  });
  zeitraumWahl.eingabe.addEventListener("change", () => {
    zeitraum = zeitraumWahl.eingabe.value;
    zeichneVerlauf();
  });
  sucheFeld.addEventListener("input", () => {
    suche = sucheFeld.value;
    zeichneRouten();
  });
  zeichne(daten);

  const ansicht = reiter("System", [
    {
      id: `${basis}-uebersicht`,
      text: "Übersicht",
      inhalt: [
        lageFeld,
        kacheln,
        el(
          "section",
          { class: "spalte", "aria-labelledby": `${basis}-fehler-kurz` },
          el(
            "div",
            { class: "zeile" },
            el("h2", { id: `${basis}-fehler-kurz` }, "Letzte Fehler"),
            knopf("Alle Anfragen", {
              art: "still",
              klein: true,
              onclick: () => ansicht.waehle(`${basis}-anfragen`),
            }),
          ),
          kurzFehler,
        ),
        panels,
      ],
    },
    {
      id: `${basis}-anfragen`,
      text: "Anfragen",
      inhalt: [
        hinweisStart,
        anfragenKachelnFeld,
        el(
          "section",
          { class: "panel" },
          el("div", { class: "zeile" }, verlaufTitel, zeitraumWahl.wurzel),
          verlauf,
        ),
        el(
          "section",
          { class: "spalte", "aria-labelledby": `${basis}-routen` },
          el("h2", { id: `${basis}-routen` }, "Anfragen je Route"),
          el(
            "div",
            { class: "werkzeuge" },
            el(
              "div",
              { class: "suche" },
              el(
                "label",
                { class: "nur-leser", for: sucheId },
                "Routen suchen",
              ),
              icon("lupe"),
              sucheFeld,
            ),
            statusWahl.wurzel,
            sortieren.wurzel,
          ),
          routenZahl,
          routen,
        ),
        el(
          "section",
          { class: "spalte", "aria-labelledby": `${basis}-fehler` },
          el("h2", { id: `${basis}-fehler` }, "Letzte Fehler"),
          fehler,
        ),
      ],
    },
    {
      id: `${basis}-aenderungen`,
      text: "Änderungen",
      inhalt: aenderungenTafel(),
    },
    { id: `${basis}-sync`, text: "Sync-Stand", inhalt: syncTafel() },
  ]);

  const nachladen = laufend(bereich, ladeBetrieb, zeichne, fehlerFeld);
  ctx.kopfAktion(
    knopf("Aktualisieren", {
      symbol: "aktualisieren",
      onclick: async () => {
        if (await nachladen()) ctx.melde("Zahlen aktualisiert.");
      },
    }),
  );
  bereich.append(
    el("div", { class: "stand-zeile" }, stand, fehlerFeld),
    ansicht.leiste,
    ...ansicht.tafeln,
  );
}

// Kacheln zu den Anfragen, auf «System» und «Übersicht» gleich
export function anfragenKacheln(a) {
  const hoch = a.quote5xx > 0.01;
  return [
    kachel({
      titel: "Anfragen (24 Std.)",
      wert: zahl(a.gesamt),
      hinweis: `${zahl(a.letzteMinute)} in der letzten Minute`,
    }),
    kachel({ titel: "Letzte Stunde", wert: zahl(a.letzteStunde) }),
    kachel({
      titel: "Fehlerquote 5xx",
      wert: prozent(a.quote5xx),
      status: hoch ? "fehler" : "ok",
      zustand: hoch ? "Erhöht" : "In Ordnung",
      hinweis: `4xx: ${prozent(a.quote4xx)}`,
    }),
    kachel({
      titel: "Dauer p50 / p95",
      wert: `${ms(a.p50Ms)} / ${ms(a.p95Ms)}`,
      hinweis: "Obergrenze der Dauerklasse",
    }),
  ];
}
