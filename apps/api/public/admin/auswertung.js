import { anfrage, fehlertext } from "./api.js";
import {
  auswahl,
  chip,
  el,
  filterGruppe,
  icon,
  knopf,
  neueId,
  seitenblatt,
  seitenwahl,
  tabelle,
} from "./dom.js";
import { datumfeld } from "./datumfeld.js";
import { abzeichen } from "./raenge.js";

// Auswertung auf Basis der Anmeldungen (Ja, Nein, offen), nie der Anwesenheit; kein Export. Eigenes Modul mit dem Einstieg zeige(bereich, ctx) wie die übrigen Bereiche: Zum Einhängen genügt ein Eintrag in BEREICHE von admin.js. Die Zahlen kommen fertig von /api/v1/admin/auswertung/*; hier wird nur angezeigt.

const BASIS = "/api/v1/admin/auswertung";
const ZAHL = new Intl.NumberFormat("de-CH");
const PROZENT = new Intl.NumberFormat("de-CH", {
  style: "percent",
  maximumFractionDigits: 0,
});
const ZEIT = new Intl.DateTimeFormat("de-CH", {
  timeZone: "Europe/Zurich",
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const MONATE = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];
const ROLLEN = {
  kommandant: "Kommandant/in",
  stellvertretung: "Stellvertretung",
  leitung: "Leitung",
};
const ANTWORTEN = {
  ja: ["Ja", "ok", "haken"],
  nein: ["Nein", "warn", "schliessen"],
  offen: ["Offen", undefined, "uhr"],
  warteliste: ["Warteliste", "warn", "uhr"],
};

const zahl = (n) => ZAHL.format(n);
const quote = (q) => (q === null || q === undefined ? "–" : PROZENT.format(q));
// «2025-06-30» -> «30.06.2025»
const tagText = (s) => s.split("-").reverse().join(".");
const termineText = (n) => `${zahl(n)} ${n === 1 ? "Termin" : "Termine"}`;

function terminDatum(t) {
  if (t.beginn) return ZEIT.format(new Date(t.beginn));
  if (t.tagBis && t.tagBis !== t.tagVon) {
    return `${tagText(t.tagVon)} – ${tagText(t.tagBis)}`;
  }
  return tagText(t.tagVon);
}

// Auf der Warteliste steht die Nummer dabei: «Warteliste 2»
function antwortChip(antwort, position) {
  const [text, art, symbol] = ANTWORTEN[antwort];
  return el(
    "ul",
    { class: "chips" },
    chip(position ? `${text} ${position}` : text, art, symbol),
  );
}

function kachel(titel, wert, hinweis) {
  return el(
    "div",
    { class: "kachel" },
    el("p", { class: "kachel-titel" }, titel),
    el("p", { class: "kachel-wert" }, wert),
    hinweis && el("p", { class: "kachel-hinweis" }, hinweis),
  );
}

// «Ja 12 · Nein 3 · Offen 5»; null, wenn die Gruppe ausgefiltert ist
function jaNeinOffen(z) {
  if (!z) return "–";
  const text = `Ja ${zahl(z.ja)} · Nein ${zahl(z.nein)} · Offen ${zahl(z.offen)}`;
  // Die Warteliste gibt es nur bei Terminen mit Höchstzahl
  return z.warteliste === undefined
    ? text
    : `${text} · Warteliste ${zahl(z.warteliste)}`;
}

function leer(text) {
  return el("p", { class: "leer leer--klein" }, icon("info"), " ", text);
}

function fehlerHinweis(f) {
  return el(
    "p",
    { class: "hinweis hinweis--fehler", role: "alert" },
    fehlertext(f),
  );
}

// Lädt in einen Behälter und verwirft späte Antworten einer älteren Anfrage
function ladeIn(behaelter, laden, zeichnen) {
  let nummer = 0;
  return async () => {
    const meine = ++nummer;
    behaelter.replaceChildren(
      el("p", { class: "meta", role: "status" }, "Wird geladen …"),
    );
    try {
      const daten = await laden();
      if (meine !== nummer || !behaelter.isConnected) return;
      behaelter.replaceChildren(...[zeichnen(daten)].flat().filter(Boolean));
    } catch (f) {
      if (meine !== nummer || !behaelter.isConnected) return;
      behaelter.replaceChildren(fehlerHinweis(f));
    }
  };
}

function abfrage(parameter) {
  const q = new window.URLSearchParams();
  for (const [name, wert] of Object.entries(parameter)) {
    if (wert !== undefined && wert !== "") q.set(name, String(wert));
  }
  return q.toString();
}

// Drilldown: Zahlen und Termine einer Person im gewählten Zeitraum, als Seitenblatt (Pop-out)
function oeffnePerson(person, zeitraum) {
  const art = person.art === "leitende" ? "leitende" : "teilnehmende";
  const inhalt = el("div", { class: "spalte" });
  const rolle = person.rolle ? ` · ${ROLLEN[person.rolle]}` : "";
  seitenblatt({
    titel: person.name,
    untertitel: `${person.einheit.name}${rolle}`,
    inhalt,
  });
  ladeIn(
    inhalt,
    () =>
      anfrage(
        "GET",
        `${BASIS}/einheiten/${person.einheit.id}/${art}/${person.id}?${abfrage(zeitraum)}`,
      ),
    (d) => [
      el(
        "p",
        { class: "meta" },
        `Zeitraum ${tagText(d.von)} bis ${tagText(d.bis)}. Gezählt werden aktive Programme, die schon begonnen haben.`,
      ),
      el(
        "div",
        { class: "kacheln" },
        kachel("Quote", quote(d.zahlen.quote), termineText(d.zahlen.termine)),
        kachel("Ja", zahl(d.zahlen.ja)),
        kachel("Nein", zahl(d.zahlen.nein)),
        kachel("Offen", zahl(d.zahlen.offen)),
      ),
      d.termine.length === 0
        ? leer("Keine Termine in diesem Zeitraum.")
        : tabelle({
            beschriftung: `Termine von ${person.name}`,
            spalten: ["Datum", "Termin", "Antwort"],
            zeilen: d.termine.map((t) =>
              el(
                "tr",
                {},
                el("th", { scope: "row" }, terminDatum(t)),
                el("td", {}, t.titel),
                el("td", {}, antwortChip(t.antwort)),
              ),
            ),
          }).wurzel,
    ],
  )();
}

// Präsenzliste: Ja, Nein, offen; Teilnehmende und Leitende getrennt
function oeffneTermin(termin) {
  const inhalt = el("div", { class: "spalte" });
  seitenblatt({
    titel: termin.titel,
    untertitel: `${terminDatum(termin)} · ${termin.einheit.name}`,
    inhalt,
  });
  const REIHE = { ja: 0, warteliste: 1, nein: 2, offen: 3 };
  const gruppe = (titel, zahlen, zeilen, name, plaetze) =>
    el(
      "section",
      { class: "spalte", "aria-label": titel },
      el("h3", {}, titel),
      el("p", { class: "meta" }, jaNeinOffen(zahlen)),
      plaetze &&
        el(
          "p",
          { class: "meta" },
          `Leiter-Plätze: ${zahl(plaetze.belegt)} von ${zahl(plaetze.hoechstzahl)} belegt${plaetze.voll ? " (voll)" : ""}`,
        ),
      zeilen.length === 0
        ? leer("Niemand.")
        : tabelle({
            beschriftung: titel,
            spalten: ["Name", "Antwort"],
            zeilen: [...zeilen]
              .sort(
                (a, b) =>
                  REIHE[a.status] - REIHE[b.status] ||
                  (a.position ?? 0) - (b.position ?? 0),
              )
              .map((p) =>
                el(
                  "tr",
                  {},
                  el("th", { scope: "row" }, name(p)),
                  el("td", {}, antwortChip(p.status, p.position)),
                ),
              ),
          }).wurzel,
    );
  ladeIn(
    inhalt,
    () => anfrage("GET", `${BASIS}/termine/${termin.id}`),
    (d) => [
      d.termin.status === "abgesagt" &&
        el(
          "p",
          { class: "hinweis hinweis--warn" },
          "Dieser Termin ist abgesagt und zählt nicht in die Quote.",
        ),
      !d.termin.begonnen &&
        el(
          "p",
          { class: "hinweis" },
          "Dieser Termin hat noch nicht begonnen: Offen heisst noch keine Antwort und zählt noch nicht in die Quote.",
        ),
      gruppe(
        "Teilnehmende",
        d.zahlen.teilnehmende,
        d.teilnehmende,
        (p) => `${p.vorname} ${p.nachname}`,
      ),
      gruppe(
        "Leitende",
        d.zahlen.leitende,
        d.leitende,
        (p) =>
          p.rolle === "leitung" ? p.name : `${p.name} (${ROLLEN[p.rolle]})`,
        d.leitungPlaetze,
      ),
    ],
  )();
}

export function zeige(bereich, ctx) {
  zeichne(bereich, ctx);
}

// Die Auswertung gilt immer für die gewählte Einheit; eine andere wählt man im Dock
function zeichne(bereich, ctx) {
  const jetzt = new Date().getFullYear();
  const zustand = {
    ansicht: "quote",
    von: `${jetzt}-01-01`,
    bis: `${jetzt}-12-31`,
    jahr: String(jetzt),
    rolle: "",
    suche: "",
    sortierung: "name",
  };

  const ergebnis = el("div", { class: "spalte" });
  const meldung = el("p", {
    class: "hinweis hinweis--fehler",
    role: "alert",
    hidden: true,
  });
  const ansichtGruppe = filterGruppe({
    beschriftung: "Ansicht",
    eintraege: [
      { text: "Quote pro Person", wert: "quote" },
      { text: "Termine", wert: "termine" },
      { text: "Jahresübersicht", wert: "jahr" },
    ],
    wert: zustand.ansicht,
    beiAenderung: (wert) => {
      zustand.ansicht = wert;
      sichtbarkeit();
      aktualisiere();
    },
  });
  const rolleGruppe = filterGruppe({
    beschriftung: "Rolle",
    eintraege: [
      { text: "Alle", wert: "" },
      { text: "Teilnehmende", wert: "teilnehmende" },
      { text: "Leitende", wert: "leitende" },
    ],
    wert: zustand.rolle,
    beiAenderung: (wert) => {
      zustand.rolle = wert;
      aktualisiere();
    },
  });

  const von = datumfeld({ label: "Von", wert: zustand.von });
  const bis = datumfeld({ label: "Bis", wert: zustand.bis });
  const jahre = Array.from({ length: 8 }, (_, i) => String(jetzt + 1 - i));
  const jahrWahl = auswahl({
    label: "Jahr",
    optionen: jahre.map((j) => [j, j]),
    wert: zustand.jahr,
  });
  const zeitraumFelder = el("div", { class: "reihe" }, von.wurzel, bis.wurzel);
  const jahrFeld = el("div", { class: "reihe" }, jahrWahl.wurzel);

  jahrWahl.eingabe.addEventListener("change", () => {
    zustand.jahr = jahrWahl.eingabe.value;
    aktualisiere();
  });
  for (const [f, name] of [
    [von, "von"],
    [bis, "bis"],
  ]) {
    f.eingabe.addEventListener("change", () => {
      zustand[name] = f.eingabe.value;
      aktualisiere();
    });
  }

  function sichtbarkeit() {
    zeitraumFelder.hidden = zustand.ansicht === "jahr";
    jahrFeld.hidden = zustand.ansicht !== "jahr";
  }

  // Dieselben Grenzen wie die API: von vor bis, höchstens 366 Tage
  function zeitraumFehler() {
    if (zustand.ansicht === "jahr") return null;
    if (!zustand.von || !zustand.bis) return "Bitte Von und Bis wählen.";
    if (zustand.von > zustand.bis) return "Von liegt nach Bis.";
    const tage = (Date.parse(zustand.bis) - Date.parse(zustand.von)) / 864e5;
    return tage > 366 ? "Der Zeitraum darf höchstens ein Jahr umfassen." : null;
  }

  const filterQuery = () => ({
    einheitId: ctx.einheit.id,
    rolle: zustand.rolle,
  });
  const zeitraum = () => ({ von: zustand.von, bis: zustand.bis });

  const ansichten = {
    quote: ladeIn(
      ergebnis,
      () =>
        anfrage(
          "GET",
          `${BASIS}/quoten?${abfrage({ ...zeitraum(), ...filterQuery() })}`,
        ),
      (d) => zeichneQuoten(d, zustand),
    ),
    termine: ladeIn(
      ergebnis,
      () =>
        anfrage(
          "GET",
          `${BASIS}/termine?${abfrage({ ...zeitraum(), ...filterQuery() })}`,
        ),
      (d) => zeichneTermine(d),
    ),
    jahr: ladeIn(
      ergebnis,
      () =>
        anfrage(
          "GET",
          `${BASIS}/jahr?${abfrage({ jahr: zustand.jahr, ...filterQuery() })}`,
        ),
      (d) => zeichneJahr(d),
    ),
  };

  function aktualisiere() {
    const fehler = zeitraumFehler();
    meldung.hidden = fehler === null;
    meldung.textContent = fehler ?? "";
    if (fehler) {
      ergebnis.replaceChildren();
      return;
    }
    // Der Zeitraum ändert sich, die Suche bleibt, die Seite beginnt vorn
    return ansichten[zustand.ansicht]();
  }

  ctx.kopfAktion(
    knopf("Aktualisieren", {
      symbol: "aktualisieren",
      onclick: aktualisiere,
    }),
  );
  sichtbarkeit();
  bereich.append(
    el(
      "p",
      { class: "hilfe" },
      "Grundlage sind die Anmeldungen, keine Präsenzkontrolle. Es zählen aktive Termine, die schon begonnen haben; bei Terminen in der Zukunft sagt «Offen» noch nichts. Inaktive Personen fehlen. Es gibt keinen Export.",
    ),
    el("div", { class: "werkzeuge" }, ansichtGruppe.wurzel, rolleGruppe.wurzel),
    el("div", { class: "werkzeuge" }, zeitraumFelder, jahrFeld),
    meldung,
    ergebnis,
  );
  aktualisiere();
}

const SORTIERUNGEN = [
  ["name", "Name"],
  ["quote-tief", "Quote: tiefste zuerst"],
  ["quote-hoch", "Quote: höchste zuerst"],
];

function zeichneQuoten(d, zustand) {
  if (d.personen.length === 0) {
    return leer("Keine Personen mit Terminen in diesem Zeitraum.");
  }
  const summe = (art) => {
    const z = d.personen.filter((p) => p.art === art);
    const ja = z.reduce((s, p) => s + p.ja, 0);
    const alle = z.reduce((s, p) => s + p.termine, 0);
    return { personen: z.length, quote: alle === 0 ? null : ja / alle };
  };
  const tn = summe("teilnehmende");
  const le = summe("leitende");
  const sucheId = neueId("suche");
  const suche = el("input", {
    id: sucheId,
    class: "eingabe",
    type: "search",
    placeholder: "Name",
    autocomplete: "off",
  });
  suche.value = zustand.suche;
  const sortieren = auswahl({
    label: "Sortieren",
    optionen: SORTIERUNGEN,
    wert: zustand.sortierung,
  });
  const anzahl = el("p", { class: "klein leise", role: "status" });
  const behaelter = el("div", {});
  const seiten = seitenwahl({ beiWechsel: zeichneTabelle });

  function zeichneTabelle() {
    const text = zustand.suche.trim().toLowerCase();
    const liste = d.personen
      .filter((p) => p.name.toLowerCase().includes(text))
      .sort((a, b) => {
        if (zustand.sortierung === "name") return 0;
        // Ohne Quote (keine Termine) ans Ende
        const wert = (p) =>
          p.quote ?? (zustand.sortierung === "quote-tief" ? 2 : -1);
        return zustand.sortierung === "quote-tief"
          ? wert(a) - wert(b)
          : wert(b) - wert(a);
      });
    anzahl.textContent =
      liste.length === d.personen.length
        ? `${zahl(liste.length)} Personen`
        : `${zahl(liste.length)} von ${zahl(d.personen.length)} Personen`;
    const [anfang, ende] = seiten.fenster(liste.length);
    if (liste.length === 0) {
      behaelter.replaceChildren(leer("Keine Person passt zur Suche."));
      return;
    }
    behaelter.replaceChildren(
      tabelle({
        beschriftung: "Teilnahmequote pro Person",
        spalten: [
          "Name",
          "Einheit",
          "Rolle",
          ["Termine", "zahl"],
          ["Ja", "zahl"],
          ["Nein", "zahl"],
          ["Offen", "zahl"],
          ["Quote", "zahl"],
          "Aktionen",
        ],
        zeilen: liste.slice(anfang, ende).map((p) =>
          el(
            "tr",
            {},
            el("th", { scope: "row" }, p.name),
            el("td", {}, p.einheit.name),
            el(
              "td",
              {},
              el(
                "span",
                { class: "rang-zelle" },
                abzeichen(p.rang, "k"),
                p.art === "teilnehmende" ? "Teilnehmende" : ROLLEN[p.rolle],
              ),
            ),
            el("td", { class: "zahl" }, zahl(p.termine)),
            el("td", { class: "zahl" }, zahl(p.ja)),
            el("td", { class: "zahl" }, zahl(p.nein)),
            el("td", { class: "zahl" }, zahl(p.offen)),
            el("td", { class: "zahl" }, quote(p.quote)),
            el(
              "td",
              { class: "rechts" },
              knopf("Details", {
                klein: true,
                kontext: p.name,
                onclick: () => oeffnePerson(p, { von: d.von, bis: d.bis }),
              }),
            ),
          ),
        ),
      }).wurzel,
    );
  }

  suche.addEventListener("input", () => {
    zustand.suche = suche.value;
    seiten.anfang();
    zeichneTabelle();
  });
  sortieren.eingabe.addEventListener("change", () => {
    zustand.sortierung = sortieren.eingabe.value;
    seiten.anfang();
    zeichneTabelle();
  });
  zeichneTabelle();
  return [
    el(
      "div",
      { class: "kacheln" },
      tn.personen > 0 &&
        kachel(
          "Quote Teilnehmende",
          quote(tn.quote),
          `${zahl(tn.personen)} Personen`,
        ),
      le.personen > 0 &&
        kachel(
          "Quote Leitende",
          quote(le.quote),
          `${zahl(le.personen)} Personen`,
        ),
    ),
    el(
      "div",
      { class: "werkzeuge" },
      el(
        "div",
        { class: "suche" },
        el("label", { class: "nur-leser", for: sucheId }, "Personen suchen"),
        icon("lupe"),
        suche,
      ),
      sortieren.wurzel,
      anzahl,
    ),
    behaelter,
    seiten.wurzel,
  ];
}

function zeichneTermine(d) {
  if (d.termine.length === 0) return leer("Keine Termine in diesem Zeitraum.");
  const behaelter = el("div", {});
  const seiten = seitenwahl({ beiWechsel: zeichneTabelle });
  function zeichneTabelle() {
    const [anfang, ende] = seiten.fenster(d.termine.length);
    behaelter.replaceChildren(
      tabelle({
        beschriftung: "Termine mit Anmeldungen",
        spalten: [
          "Datum",
          "Termin",
          "Einheit",
          "Teilnehmende",
          "Leitende",
          "Aktionen",
        ],
        zeilen: d.termine.slice(anfang, ende).map((t) =>
          el(
            "tr",
            {},
            el("th", { scope: "row" }, terminDatum(t)),
            el(
              "td",
              {},
              t.titel,
              t.status === "abgesagt" &&
                el("ul", { class: "chips" }, chip("Abgesagt", "warn")),
              t.status !== "abgesagt" &&
                !t.begonnen &&
                el(
                  "ul",
                  { class: "chips" },
                  chip("Noch nicht begonnen", undefined, "uhr"),
                ),
            ),
            el("td", {}, t.einheit.name),
            el("td", {}, jaNeinOffen(t.teilnehmende)),
            el("td", {}, jaNeinOffen(t.leitende)),
            el(
              "td",
              { class: "rechts" },
              knopf("Präsenzliste", {
                klein: true,
                kontext: `${t.titel}, ${terminDatum(t)}`,
                onclick: () => oeffneTermin(t),
              }),
            ),
          ),
        ),
      }).wurzel,
    );
  }
  zeichneTabelle();
  return [
    el("p", { class: "klein leise" }, `${zahl(d.termine.length)} Termine`),
    behaelter,
    seiten.wurzel,
  ];
}

function zeichneJahr(d) {
  if (d.einheiten.length === 0) return leer("Keine Einheit im Bereich.");
  return d.einheiten.map((e) => {
    const mitTn = e.teilnehmende !== null;
    const mitLe = e.leitende !== null;
    const spalten = [
      "Monat",
      ["Termine", "zahl"],
      ...(mitTn
        ? [
            ["Teiln. Ja", "zahl"],
            ["Nein", "zahl"],
            ["Offen", "zahl"],
            ["Quote", "zahl"],
          ]
        : []),
      ...(mitLe
        ? [
            ["Leit. Ja", "zahl"],
            ["Nein", "zahl"],
            ["Offen", "zahl"],
            ["Quote", "zahl"],
          ]
        : []),
    ];
    const zellen = (z) =>
      z
        ? [z.ja, z.nein, z.offen]
            .map((n) => el("td", { class: "zahl" }, zahl(n)))
            .concat(el("td", { class: "zahl" }, quote(z.quote)))
        : [];
    return el(
      "section",
      { class: "panel" },
      el(
        "h2",
        {},
        `${e.einheit.name} (${e.einheit.typ === "jf" ? "JF" : "KF"}) · ${e.einheit.bezirk.name}`,
      ),
      el(
        "div",
        { class: "kacheln" },
        kachel("Termine", zahl(e.termine), `${zahl(e.kommend)} kommen noch`),
        mitTn &&
          kachel(
            "Quote Teilnehmende",
            quote(e.teilnehmende.quote),
            jaNeinOffen(e.teilnehmende),
          ),
        mitLe &&
          kachel(
            "Quote Leitende",
            quote(e.leitende.quote),
            jaNeinOffen(e.leitende),
          ),
      ),
      tabelle({
        beschriftung: `Jahresübersicht ${d.jahr}: ${e.einheit.name}`,
        spalten,
        zeilen: e.monate.map((m) =>
          el(
            "tr",
            {},
            el("th", { scope: "row" }, MONATE[m.monat - 1]),
            el("td", { class: "zahl" }, zahl(m.termine)),
            zellen(m.teilnehmende),
            zellen(m.leitende),
          ),
        ),
      }).wurzel,
    );
  });
}
