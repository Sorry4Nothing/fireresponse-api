import { anfrage, fehlertext } from "./api.js";
import {
  ARTEN,
  MAX_BYTES,
  MAX_ZEILEN,
  baueZeilen,
  dekodiere,
  entschaerfe,
  findeEbene,
  kannSchnellweg,
  liesCsv,
  schlageArtVor,
  schlageSpaltenVor,
  schreibeCsv,
  verschiedeneRollen,
} from "./csv.js";
import {
  auswahl,
  bestaetigen,
  chip,
  el,
  feld,
  filterGruppe,
  gruppe,
  icon,
  knopf,
  neueId,
  seitenwahl,
  tabelle,
} from "./dom.js";
import { kachel } from "./system.js";

export function zeige(bereich, ctx) {
  ctx.lade(
    async () => (await anfrage("GET", "/api/v1/stufen")).stufen,
    (stufen, neu) => zeichne(bereich, ctx, stufen, neu),
  );
}

const TRENNERNAME = { ";": "Semikolon", ",": "Komma", "\t": "Tabulator" };
const zeilenText = (n) => (n === 1 ? "1 Zeile" : `${n} Zeilen`);
const kinderText = (n) => (n === 1 ? "1 Kind" : `${n} Kinder`);
const leitendeText = (n) => (n === 1 ? "1 Leitende" : `${n} Leitende`);

// Zustand einer Zeile nie nur über Farbe: Wort und Symbol stehen im Chip
const ZUSTAENDE = {
  neu: () => chip("Neu", "ok"),
  vorhanden: () => chip("Schon vorhanden", undefined, "info"),
  doppelt: () => chip("Doppelt in der Datei", "warn"),
  ungueltig: () => chip("Ungültig", "fehler"),
  ausgelassen: () => chip("Ausgelassen", undefined, "schliessen"),
};
const ARTNAME = Object.fromEntries(ARTEN);

function fehlerfeld() {
  return el("p", {
    class: "hinweis hinweis--fehler",
    role: "alert",
    hidden: true,
    tabindex: "-1",
  });
}

function zeigeFehler(knoten, text) {
  knoten.textContent = text;
  knoten.hidden = false;
  knoten.focus();
}

// Abschnitt mit Überzeile und Überschrift (Fokusziel); setze() tauscht den Inhalt darunter
function schritt(nr, titel) {
  const ueber = el("p", { class: "ueber" }, `Schritt ${nr}`);
  const ueberschrift = el("h2", { tabindex: "-1" }, titel);
  const wurzel = el("section", { class: "panel" }, ueber, ueberschrift);
  return {
    wurzel,
    ueberschrift,
    nummer: (n) => {
      ueber.textContent = `Schritt ${n}`;
    },
    setze: (...inhalt) =>
      wurzel.replaceChildren(ueber, ueberschrift, ...inhalt.filter(Boolean)),
  };
}

// Optionsknöpfe als Segment (wie die Stufenrollen bei den Personen); legende darf Text und Knoten enthalten
function artWahl(legende, arten, gewaehlt, beiAenderung) {
  const name = neueId("art");
  const optionen = arten.map(([wert, text]) => {
    const id = neueId("art-option");
    return {
      wert,
      eingabe: el("input", {
        type: "radio",
        id,
        name,
        value: wert,
        checked: wert === gewaehlt,
        onchange: beiAenderung,
      }),
      label: el("label", { for: id }, icon("haken"), text),
    };
  });
  return {
    wurzel: el(
      "fieldset",
      { class: "rolle" },
      el("legend", {}, legende),
      el(
        "div",
        { class: "seg" },
        optionen.flatMap((o) => [o.eingabe, o.label]),
      ),
    ),
    wert: () => optionen.find((o) => o.eingabe.checked)?.wert,
  };
}

function zeichne(bereich, ctx, stufen, neu) {
  if (stufen.length === 0) {
    bereich.append(
      el(
        "p",
        { class: "leer" },
        icon("stufen"),
        " Es gibt noch keine Stufe. ",
        el("a", { href: "#stufen" }, "Lege zuerst eine Stufe an."),
      ),
    );
    return;
  }

  // Zustand der Seite; alles, was von der Datei oder den Zuordnungen abhängt, wird bei einer Änderung verworfen
  let daten = null; // { kopf, zeilen, trenner }
  let spalten = null; // { vorname, nachname, rolle }: Auswahlfelder
  let rollen = null; // () => { arten, einheit }
  let gesendet = null;
  let vorschauStufe = null;
  let schnell = false; // Spalten und Rollen sind erkannt: Schritte 2 und 3 bleiben verborgen
  let rollenText = () => "";
  let lesevorgang = 0;
  let vorschauNr = 0;

  const stufe = auswahl({
    label: "Stufe",
    optionen: stufen.map((s) => [s.id, s.name]),
    wert: stufen[0].id,
  });
  const datei = feld({
    label: "CSV-Datei",
    hilfe: `Export aus der Mitgliederdatenbank als CSV, höchstens 1 MB und ${MAX_ZEILEN} Zeilen. Die Datei wird nur in deinem Browser gelesen und nicht hochgeladen.`,
    typ: "file",
    accept: ".csv,text/csv,text/plain",
  });
  const dateiStatus = el("p", { class: "hilfe", role: "status" });
  const dateiFehler = fehlerfeld();
  const s1 = schritt(1, "Stufe und Datei");
  s1.setze(
    el(
      "p",
      { class: "beschreibung" },
      "Alle Personen der Datei kommen in diese Stufe. Es wird erst etwas angelegt, wenn du in der Vorschau «Importieren» wählst.",
    ),
    el("div", { class: "formular" }, stufe.wurzel, datei.wurzel),
    dateiStatus,
    dateiFehler,
  );
  const s2 = schritt(2, "Spalten zuordnen");
  const s3 = schritt(3, "Rollen zuordnen");
  const s4 = schritt(4, "Vorschau");
  for (const s of [s2, s3, s4]) s.wurzel.hidden = true;

  // Im Schnellweg ist die Vorschau der zweite und letzte Schritt
  function setzeModus(istSchnell) {
    schnell = istSchnell;
    s4.nummer(istSchnell ? 2 : 4);
    s4.ueberschrift.textContent = istSchnell
      ? "Vorschau und Import"
      : "Vorschau";
  }

  function leereVorschau() {
    vorschauNr++;
    gesendet = null;
    s4.wurzel.hidden = true;
  }

  function leereFolge() {
    lesevorgang++;
    daten = null;
    dateiStatus.textContent = "";
    dateiFehler.hidden = true;
    s2.wurzel.hidden = s3.wurzel.hidden = true;
    leereVorschau();
    setzeModus(false);
  }

  // Klappt Schritt 2 und 3 auf, etwa wenn die erkannte Zuordnung nicht passt; die Vorschau gilt danach nicht mehr
  function aendereZuordnung(fokus) {
    setzeModus(false);
    s2.wurzel.hidden = s3.wurzel.hidden = false;
    leereVorschau();
    if (fokus) s2.ueberschrift.focus();
  }

  async function schnellVorschau() {
    // Bei einem Fehler (Meldung steht bei der Datei) führt der Weg über die Zuordnung weiter
    if ((await zeigeVorschau(dateiFehler, { disabled: false })) === false) {
      aendereZuordnung(false);
    }
  }

  stufe.eingabe.addEventListener("change", () => {
    leereVorschau();
    if (schnell && daten) schnellVorschau();
  });

  datei.eingabe.addEventListener("change", async () => {
    leereFolge();
    const nr = lesevorgang;
    const gewaehlt = datei.eingabe.files[0];
    if (!gewaehlt) return;
    if (gewaehlt.size > MAX_BYTES) {
      zeigeFehler(
        dateiFehler,
        "Die Datei ist grösser als 1 MB. Eine Liste mit Namen ist viel kleiner: Prüfe, ob es die richtige Datei ist.",
      );
      return;
    }
    let text;
    try {
      text = dekodiere(await gewaehlt.arrayBuffer());
    } catch {
      if (nr === lesevorgang) {
        zeigeFehler(dateiFehler, "Die Datei lässt sich nicht lesen.");
      }
      return;
    }
    // Zwischen Auswahl und Ende des Lesens kann eine andere Datei gewählt worden sein
    if (nr !== lesevorgang) return;
    const gelesen = liesCsv(text);
    if (gelesen.zeilen.length === 0) {
      zeigeFehler(
        dateiFehler,
        "Die Datei enthält keine Zeilen unter der Kopfzeile.",
      );
      return;
    }
    if (gelesen.zeilen.length > MAX_ZEILEN) {
      zeigeFehler(
        dateiFehler,
        `Die Datei hat ${zeilenText(gelesen.zeilen.length)}. Pro Import sind höchstens ${MAX_ZEILEN} Zeilen möglich. Teile die Datei auf und importiere sie in mehreren Schritten.`,
      );
      return;
    }
    daten = { ...gelesen, ebene: findeEbene(gelesen.kopf) };
    dateiStatus.textContent = `Datei gelesen: ${zeilenText(daten.zeilen.length)}, Trennzeichen ${TRENNERNAME[daten.trenner] ?? daten.trenner}.`;
    zeichneSpalten();
    if (kannSchnellweg(daten.kopf, daten.zeilen)) {
      s2.wurzel.hidden = s3.wurzel.hidden = true;
      setzeModus(true);
      await schnellVorschau();
    } else {
      s2.ueberschrift.focus();
    }
  });

  const nummer = (a) => (a.eingabe.value === "" ? -1 : Number(a.eingabe.value));

  const NAMEN = {
    vorname: "Vorname",
    nachname: "Nachname",
    rolle: "Rolle",
  };
  const spaltenText = () =>
    Object.entries(spalten)
      .filter(([, a]) => nummer(a) >= 0)
      .map(
        ([k, a]) =>
          `${NAMEN[k]} aus «${daten.kopf[nummer(a)] || `Spalte ${nummer(a) + 1}`}»`,
      )
      .join(", ");

  function zeichneSpalten() {
    const vorschlag = schlageSpaltenVor(daten.kopf);
    const optionen = [
      ["", "Keine Spalte"],
      ...daten.kopf.map((name, i) => [String(i), name || `Spalte ${i + 1}`]),
    ];
    const wahl = (label, schluessel) =>
      auswahl({
        label,
        optionen,
        wert: vorschlag[schluessel] >= 0 ? String(vorschlag[schluessel]) : "",
      });
    spalten = {
      vorname: wahl("Vorname", "vorname"),
      nachname: wahl("Nachname", "nachname"),
      rolle: wahl("Rolle (optional)", "rolle"),
    };
    for (const a of Object.values(spalten)) {
      a.eingabe.addEventListener("change", leereVorschau);
    }
    spalten.rolle.eingabe.addEventListener("change", zeichneRollen);
    const vollstaendig = () => {
      const [v, n] = [nummer(spalten.vorname), nummer(spalten.nachname)];
      return v >= 0 && n >= 0 && v !== n;
    };
    const erkannt = el("p", { class: "beschreibung", role: "status" });
    const beschreibe = () => {
      erkannt.textContent = vollstaendig()
        ? `Erkannt: ${spaltenText()}.`
        : "Vorname und Nachname brauchen je eine eigene Spalte. Ordne sie unten zu.";
    };
    beschreibe();
    for (const a of Object.values(spalten)) {
      a.eingabe.addEventListener("change", beschreibe);
    }
    s2.setze(
      erkannt,
      el(
        "details",
        { class: "mehr", open: !vollstaendig() },
        el("summary", {}, "Spalten ändern"),
        gruppe(
          "Spalten der Datei",
          Object.values(spalten).map((a) => a.wurzel),
        ),
      ),
    );
    s2.wurzel.hidden = false;
    zeichneRollen();
  }

  function zeichneRollen() {
    leereVorschau();
    const spalte = nummer(spalten.rolle);
    let inhalt;
    if (spalte < 0) {
      const wahl = artWahl(
        "Art aller Personen",
        ARTEN.filter(([a]) => a !== "auslassen"),
        "kind",
        leereVorschau,
      );
      rollen = () => ({ arten: new Map(), einheit: wahl.wert() });
      rollenText = () => `alle ${ARTNAME[wahl.wert()]}`;
      inhalt = [
        el(
          "p",
          { class: "beschreibung" },
          "Die Datei hat keine Rollenspalte. Alle Zeilen bekommen dieselbe Art.",
        ),
        wahl.wurzel,
      ];
    } else {
      const werte = verschiedeneRollen(daten.zeilen, spalte, daten.ebene);
      const wahlen = werte.map((w) => ({
        schluessel: w.schluessel,
        name: w.wert || "(leer)",
        erkannt: schlageArtVor(w.wert) !== "auslassen",
        ...artWahl(
          [
            w.wert || "(leer)",
            " ",
            el("span", { class: "leise" }, `· ${zeilenText(w.anzahl)}`),
          ],
          ARTEN,
          schlageArtVor(w.wert),
          leereVorschau,
        ),
      }));
      const weitere = wahlen.filter((w) => !w.erkannt);
      rollenText = () => {
        const zugeordnet = wahlen.filter((w) => w.wert() !== "auslassen");
        const aus = wahlen.length - zugeordnet.length;
        return [
          zugeordnet.map((w) => `${w.name} → ${ARTNAME[w.wert()]}`).join(", "),
          aus > 0
            ? `${aus === 1 ? "1 weitere Rolle" : `${aus} weitere Rollen`} ausgelassen`
            : "",
        ]
          .filter(Boolean)
          .join("; ");
      };
      rollen = () => ({
        arten: new Map(wahlen.map((w) => [w.schluessel, w.wert()])),
        einheit: "kind",
      });
      inhalt = [
        el(
          "p",
          { class: "beschreibung" },
          "Teilnehmende sind Kinder, Gruppenleitende sind Leitung, Stufenleitende sind Stufenleitung. Alle anderen Rollen werden ausgelassen. Stehen in einer Zelle mehrere Rollen, gilt die stärkste Art: Stufenleitung vor Leitung vor Kind.",
        ),
        el(
          "div",
          { class: "spalte" },
          wahlen.filter((w) => w.erkannt).map((w) => w.wurzel),
        ),
        weitere.length > 0 &&
          el(
            "details",
            { class: "mehr" },
            el(
              "summary",
              {},
              `Weitere Rollen (werden ausgelassen): ${weitere.length}`,
            ),
            el(
              "div",
              { class: "spalte" },
              weitere.map((w) => w.wurzel),
            ),
          ),
      ];
    }
    const fehler = fehlerfeld();
    const vorschauKnopf = knopf("Vorschau anzeigen", {
      art: "haupt",
      symbol: "lupe",
      onclick: () => zeigeVorschau(fehler, vorschauKnopf),
    });
    s3.setze(
      ...inhalt,
      fehler,
      el("div", { class: "dialog-knoepfe" }, vorschauKnopf),
    );
    s3.wurzel.hidden = false;
  }

  async function zeigeVorschau(fehler, taste) {
    fehler.hidden = true;
    const zuordnung = Object.fromEntries(
      Object.entries(spalten).map(([name, a]) => [name, nummer(a)]),
    );
    if (zuordnung.vorname < 0 || zuordnung.nachname < 0) {
      zeigeFehler(
        fehler,
        "Ordne in Schritt 2 dem Vornamen und dem Nachnamen je eine Spalte zu.",
      );
      return false;
    }
    if (zuordnung.vorname === zuordnung.nachname) {
      zeigeFehler(
        fehler,
        "Vorname und Nachname brauchen verschiedene Spalten.",
      );
      return false;
    }
    const zeilen = baueZeilen(daten.zeilen, zuordnung, {
      ...rollen(),
      ebene: daten.ebene,
    });
    const gewaehlteStufe = {
      id: stufe.eingabe.value,
      name: stufen.find((s) => s.id === stufe.eingabe.value)?.name ?? "",
    };
    const nr = ++vorschauNr;
    taste.disabled = true;
    try {
      const antwort = await anfrage("POST", "/api/v1/admin/import/vorschau", {
        stufeId: gewaehlteStufe.id,
        zeilen,
      });
      // Wurde währenddessen etwas geändert, passt die Antwort nicht mehr
      if (nr !== vorschauNr) return;
      if (antwort.zeilen.length !== zeilen.length) {
        throw new Error("Antwort passt nicht zur Anfrage");
      }
      gesendet = zeilen;
      vorschauStufe = gewaehlteStufe;
      zeichneVorschau(antwort);
      s4.ueberschrift.focus();
      return true;
    } catch (f) {
      if (nr === vorschauNr) {
        zeigeFehler(fehler, fehlertext(f));
        return false;
      }
    } finally {
      taste.disabled = false;
    }
  }

  function zeichneVorschau({ zeilen: antworten, summe }) {
    const nachName = (z) => `${z.vorname} ${z.nachname}`;
    const { wurzel, koerper } = tabelle({
      beschriftung: "Vorschau des Imports",
      spalten: [["Nr.", "zahl"], "Person", "Zustand", "Art", "Benutzername"],
      zeilen: antworten.map((a, i) => {
        const z = gesendet[i];
        return el(
          "tr",
          {
            class: a.status === "neu" ? undefined : "inaktiv",
            "data-status": a.status,
          },
          el("td", { class: "zahl" }, String(i + 1)),
          el(
            "th",
            { scope: "row" },
            el("span", { class: "name" }, nachName(z)),
          ),
          el(
            "td",
            {},
            el(
              "ul",
              { class: "chips" },
              (ZUSTAENDE[a.status] ?? (() => chip(a.status)))(),
            ),
            a.grund && el("p", { class: "hilfe" }, a.grund),
          ),
          el(
            "td",
            {},
            a.status === "ausgelassen" || a.status === "ungueltig"
              ? el("span", { class: "leise" }, "–")
              : el("ul", { class: "chips" }, chip(ARTNAME[a.art] ?? a.art)),
          ),
          el(
            "td",
            {},
            a.benutzername
              ? el("span", { class: "mono" }, a.benutzername)
              : el("span", { class: "leise" }, "–"),
          ),
        );
      }),
    });

    const zaehler = el("p", { class: "meta klein", role: "status" });
    const seiten = seitenwahl({ beiWechsel: aktualisiere });
    const eintraege = [
      { text: "Alle", n: antworten.length, wert: "" },
      ...[
        ["neu", "Neu"],
        ["vorhanden", "Schon vorhanden"],
        ["doppelt", "Doppelt"],
        ["ungueltig", "Ungültig"],
        ["ausgelassen", "Ausgelassen"],
      ]
        .map(([wert, text]) => ({
          text,
          wert,
          n: antworten.filter((a) => a.status === wert).length,
        }))
        .filter((e) => e.n > 0),
    ];
    const filter = filterGruppe({
      beschriftung: "Zustand",
      eintraege,
      beiAenderung: () => {
        seiten.anfang();
        aktualisiere();
      },
    });
    function aktualisiere() {
      const gesucht = filter.wert();
      const treffer = [...koerper.children].filter(
        (tr) => gesucht === "" || tr.dataset.status === gesucht,
      );
      const [von, bis] = seiten.fenster(treffer.length);
      const sichtbar = new Set(treffer.slice(von, bis));
      for (const tr of koerper.children) tr.hidden = !sichtbar.has(tr);
      zaehler.textContent = `${treffer.length} von ${zeilenText(antworten.length)}`;
    }
    aktualisiere();

    const hinweis =
      summe.neu === 0
        ? el(
            "p",
            { class: "hinweis hinweis--warn" },
            "Es gibt nichts Neues anzulegen.",
          )
        : el(
            "p",
            { class: "hinweis" },
            `Beim Importieren werden ${kinderText(summe.kinder)} und ${leitendeText(summe.leitende)} in der Stufe «${vorschauStufe.name}» angelegt. Alle anderen Zeilen werden übersprungen.`,
          );
    s4.setze(
      schnell &&
        el(
          "div",
          { class: "zeile" },
          el(
            "p",
            { class: "beschreibung" },
            `Erkannt: ${spaltenText()} · Rollen: ${rollenText()}.`,
          ),
          knopf("Zuordnung ändern", {
            klein: true,
            onclick: () => aendereZuordnung(true),
          }),
        ),
      el("div", { class: "kacheln" }, [
        kachel({
          titel: "Neu",
          wert: String(summe.neu),
          hinweis: `${kinderText(summe.kinder)}, ${leitendeText(summe.leitende)}`,
          status: summe.neu > 0 ? "ok" : undefined,
        }),
        kachel({
          titel: "Schon vorhanden",
          wert: String(summe.vorhanden),
          hinweis: "Wird übersprungen",
        }),
        kachel({
          titel: "Doppelt in der Datei",
          wert: String(summe.doppelt),
          hinweis: "Ab dem zweiten Vorkommen",
          status: summe.doppelt > 0 ? "warn" : undefined,
        }),
        kachel({
          titel: "Ungültig",
          wert: String(summe.ungueltig),
          hinweis: "Wird übersprungen",
          status: summe.ungueltig > 0 ? "fehler" : undefined,
        }),
        kachel({
          titel: "Ausgelassen",
          wert: String(summe.ausgelassen),
          hinweis: "Art «Auslassen»",
        }),
      ]),
      el(
        "div",
        { class: "zeile" },
        hinweis,
        summe.neu > 0 &&
          knopf("Importieren", {
            art: "haupt",
            symbol: "ablage",
            onclick: () => starteImport(summe),
          }),
      ),
      el("div", { class: "werkzeuge" }, filter.wurzel),
      zaehler,
      wurzel,
      seiten.wurzel,
    );
    s4.wurzel.hidden = false;
  }

  function starteImport(summe) {
    const uebersprungen = gesendet.length - summe.neu;
    let ergebnis = null;
    const dialog = bestaetigen({
      titel: "Import starten",
      beschreibung: `In der Stufe «${vorschauStufe.name}» werden ${kinderText(summe.kinder)} und ${leitendeText(summe.leitende)} angelegt.${summe.leitende > 0 ? " Die Leitenden bekommen ein Startpasswort. Es bleibt in der Personenliste sichtbar, bis die Person es ersetzt hat." : ""}${uebersprungen > 0 ? ` ${zeilenText(uebersprungen)} werden übersprungen.` : ""}`,
      ok: "Importieren",
      gefaehrlich: false,
      aktion: () =>
        anfrage("POST", "/api/v1/admin/import", {
          stufeId: vorschauStufe.id,
          zeilen: gesendet,
        }),
      danach: (antwort) => {
        ergebnis = antwort;
      },
    });
    // Läuft nach dem Schliessen-Handler des Dialogs, der den Fokus zurückgibt; so landet der Fokus zuletzt auf der Ergebnisansicht
    dialog.addEventListener("close", () => {
      if (ergebnis) zeigeErgebnis(ergebnis);
    });
  }

  function zeigeErgebnis(ergebnis) {
    const leitende = ergebnis.leitende;
    const ueberschrift = el("h2", { tabindex: "-1" }, "Import abgeschlossen");
    const rueck = el("p", { class: "hilfe", role: "status" });
    const wurzel = el("section", { class: "panel" });
    const rueckmeldung = (text) => {
      rueck.textContent = "";
      setTimeout(() => {
        rueck.textContent = text;
      }, 50);
    };
    const alsText = () =>
      leitende
        .map((p) => [p.name, p.benutzername, p.startpasswort].join("\t"))
        .join("\n");
    const inhalt = [el("p", { class: "ueber" }, "Ergebnis"), ueberschrift];
    if (leitende.length > 0) {
      const { wurzel: liste } = tabelle({
        beschriftung: "Neue Konten mit Startpasswort",
        spalten: ["Name", "Benutzername", "Startpasswort"],
        zeilen: leitende.map((p) =>
          el(
            "tr",
            {},
            el("th", { scope: "row" }, el("span", { class: "name" }, p.name)),
            el("td", {}, el("span", { class: "mono" }, p.benutzername)),
            el("td", {}, el("span", { class: "mono" }, p.startpasswort)),
          ),
        ),
      });
      inhalt.push(
        el(
          "p",
          { class: "hinweis hinweis--warn" },
          "Die Startpasswörter erscheinen nur jetzt. Kopiere oder speichere sie, bevor du diese Seite verlässt. Sie gelten 7 Tage.",
        ),
        el(
          "div",
          { class: "reihe" },
          knopf("Alles kopieren", {
            symbol: "kopieren",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(alsText());
                rueckmeldung("Kopiert.");
              } catch {
                rueckmeldung(
                  "Kopieren ist nicht möglich. Speichere die Liste als CSV.",
                );
              }
            },
          }),
          knopf("Als CSV speichern", {
            symbol: "ablage",
            onclick: () => {
              speichere(leitende);
              rueckmeldung("Die Datei wird gespeichert.");
            },
          }),
        ),
        rueck,
        liste,
      );
    } else {
      inhalt.push(
        el(
          "p",
          { class: "leise" },
          "Es sind keine Konten entstanden, darum gibt es keine Startpasswörter.",
        ),
      );
    }
    inhalt.push(
      el(
        "div",
        { class: "dialog-knoepfe" },
        knopf("Fertig", { art: "haupt", onclick: wische }),
      ),
    );
    wurzel.append(...inhalt);

    // Die Startpasswörter bleiben nur in dieser Ansicht: Beim Verlassen und bei «Fertig» werden Liste und Seitentext gelöscht
    function wische() {
      window.removeEventListener("hashchange", wische);
      leitende.length = 0;
      wurzel.replaceChildren();
      if (!wurzel.isConnected) return;
      ctx.melde("");
      // Der Knopf «Fertig» verschwindet mit der Ansicht: Der Fokus gehört danach der Überschrift der Seite
      neu().then(() => document.querySelector("h1")?.focus());
    }
    window.addEventListener("hashchange", wische);

    bereich.replaceChildren(wurzel);
    ctx.melde(
      `${kinderText(ergebnis.kinder)} und ${leitendeText(leitende.length)} sind angelegt.${ergebnis.uebersprungen > 0 ? ` ${zeilenText(ergebnis.uebersprungen)} wurden übersprungen.` : ""}`,
    );
    ueberschrift.focus();
  }

  bereich.append(
    el(
      "p",
      { class: "hinweis" },
      "Hier legst du Kinder und Leitende aus einem CSV-Export an. Zuerst zeigt die Vorschau, was passieren würde. Eine Elternverknüpfung gehört nicht dazu.",
    ),
    s1.wurzel,
    s2.wurzel,
    s3.wurzel,
    s4.wurzel,
  );
}

// Lädt die Liste der neuen Konten als CSV herunter; der Dateiname enthält keine Personendaten
function speichere(leitende) {
  const zeilen = [
    ["Name", "Benutzername", "Startpasswort"],
    ...leitende.map((p) => [
      entschaerfe(p.name),
      p.benutzername,
      p.startpasswort,
    ]),
  ];
  // BOM, damit Tabellenprogramme die Umlaute richtig lesen
  const blob = new Blob(["﻿", schreibeCsv(zeilen)], {
    type: "text/csv;charset=utf-8",
  });
  const adresse = window.URL.createObjectURL(blob);
  const link = el("a", {
    href: adresse,
    download: `startpasswoerter-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => window.URL.revokeObjectURL(adresse), 1000);
}
