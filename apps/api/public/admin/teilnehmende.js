import { anfrage, fehlertext } from "./api.js";
import {
  aktionenZelle,
  bestaetigen,
  chip,
  dialogFormular,
  el,
  feld,
  filterGruppe,
  geheimnisDialog,
  icon,
  knopf,
  menue,
  neueId,
  seitenblatt,
  seitenwahl,
  tabelle,
} from "./dom.js";
import {
  aufgabenHinweis,
  BENUTZERNAME_HILFE,
  kontoMenueEintraege,
  mehrzahl,
  zustandsChips,
} from "./konten.js";
import { abzeichen, raengeAuswahl, raengeVomTyp } from "./raenge.js";

// Suche und Filter überleben das Neuladen nach einer Aktion; fokus: Person, deren Zeile danach den Fokus bekommt
const zustand = { frage: "", filter: "alle", fokus: null };

const FILTER = [
  ["alle", "Alle"],
  ["ohne", "Ohne Konto"],
  ["eltern", "Eltern antworten"],
  ["selbst", "Antworten selbst"],
  ["inaktiv", "Inaktiv"],
];

const basis = (einheit) => `/api/v1/admin/einheiten/${einheit.id}`;
const vollerName = (t) => `${t.vorname} ${t.nachname}`;
const hatSelbst = (t) => t.konten.some((k) => k.art === "selbst");

export function zeige(bereich, ctx) {
  zustand.frage = "";
  zustand.filter = "alle";
  zustand.fokus = null;
  const einheit = ctx.einheit;
  ctx.lade(
    async () => {
      const [personen, raenge] = await Promise.all([
        anfrage("GET", `${basis(einheit)}/teilnehmende`),
        anfrage("GET", `${basis(einheit)}/raenge`),
      ]);
      return { teilnehmende: personen.teilnehmende, raenge: raenge.raenge };
    },
    (daten, neu) => zeichne(bereich, ctx, einheit, daten, neu),
  );
}

// Neue Konten zeigen ihr Startpasswort in einem Dialog, alle zusammen; danach ist es nur noch über die Verwaltung abrufbar, solange es offen ist
function startpasswoerter(konten, ctx, text) {
  const neue = konten.filter((k) => k.startpasswort);
  if (neue.length === 0) return;
  geheimnisDialog({
    titel: neue.length === 1 ? "Startpasswort" : "Startpasswörter",
    beschreibung: `${text} Sie gelten 7 Tage und stehen nur in diesem Fenster; solange sie offen sind, zeigt die Verwaltung sie wieder an.`,
    eintraege: neue.map((k) => ({
      label: `${k.benutzername} (${k.art === "selbst" ? "eigenes Konto" : "Eltern"})`,
      wert: k.startpasswort,
    })),
  });
}

// Ein Elternteil: neues Konto oder ein bestehendes, das schon für ein anderes Kind antwortet
function elternBlock(nr, beiEntfernen) {
  const art = { wert: "neu" };
  const gruppe = neueId("eltern-art");
  const vorname = feld({ label: "Vorname", maxlength: 100 });
  const nachname = feld({ label: "Nachname", maxlength: 100 });
  const benutzername = feld({
    label: "Benutzername",
    maxlength: 64,
    autocapitalize: "none",
    autocomplete: "off",
    spellcheck: "false",
  });
  const bestehend = feld({
    label: "Benutzername des bestehenden Kontos",
    hilfe:
      "Für Eltern, die schon für ein anderes Kind antworten. Das Konto behält sein Passwort.",
    maxlength: 64,
    autocapitalize: "none",
    autocomplete: "off",
    spellcheck: "false",
  });
  const neuFelder = el(
    "div",
    { class: "formular" },
    vorname.wurzel,
    nachname.wurzel,
    benutzername.wurzel,
  );
  const alt = el("div", { class: "formular" }, bestehend.wurzel);
  const umschalten = () => {
    neuFelder.hidden = art.wert !== "neu";
    alt.hidden = art.wert !== "bestehend";
    for (const e of [vorname, nachname, benutzername]) {
      e.eingabe.toggleAttribute("required", art.wert === "neu");
    }
    bestehend.eingabe.toggleAttribute("required", art.wert === "bestehend");
  };
  const optionen = [
    ["neu", "Neues Konto"],
    ["bestehend", "Bestehendes Konto"],
  ].flatMap(([wert, text]) => {
    const id = neueId("eltern-option");
    return [
      el("input", {
        type: "radio",
        id,
        name: gruppe,
        value: wert,
        checked: wert === art.wert,
        onchange: () => {
          art.wert = wert;
          umschalten();
        },
      }),
      el("label", { for: id }, icon("haken"), text),
    ];
  });
  umschalten();
  return {
    wurzel: el(
      "div",
      {
        class: "eltern-block",
        role: "group",
        "aria-label": `Elternteil ${nr}`,
      },
      el("h3", {}, `Elternteil ${nr}`),
      el(
        "div",
        { class: "seg", role: "radiogroup", "aria-label": "Art des Kontos" },
        optionen,
      ),
      neuFelder,
      alt,
      knopf("Entfernen", {
        klein: true,
        kontext: `Elternteil ${nr}`,
        onclick: beiEntfernen,
      }),
    ),
    wert: () =>
      art.wert === "neu"
        ? {
            vorname: vorname.eingabe.value.trim(),
            nachname: nachname.eingabe.value.trim(),
            benutzername: benutzername.eingabe.value.trim(),
          }
        : { bestehendesKonto: bestehend.eingabe.value.trim() },
  };
}

function anlegen(einheit, daten, ctx, neu) {
  const vorname = feld({ label: "Vorname", maxlength: 100, required: true });
  const nachname = feld({ label: "Nachname", maxlength: 100, required: true });
  const rang = raengeAuswahl(
    raengeVomTyp(daten.raenge, einheit.typ),
    "",
    "Rang",
  );
  const art = { wert: "eltern" };
  const gruppe = neueId("antwort-art");
  const benutzername = feld({
    label: "Benutzername der Person",
    hilfe: BENUTZERNAME_HILFE,
    maxlength: 64,
    autocapitalize: "none",
    autocomplete: "off",
    spellcheck: "false",
  });
  const selbstFeld = el("div", { class: "formular" }, benutzername.wurzel);
  const eltern = [];
  const elternListe = el("div", { class: "formular" });
  const hinzufuegen = knopf("Elternteil hinzufügen", {
    symbol: "plus",
    onclick: () => neuesElternteil(),
  });
  const keine = el(
    "p",
    { class: "hilfe" },
    "Ohne Elternteil antwortet für die Person niemand, bis du Eltern hinzufügst.",
  );
  const elternBereich = el(
    "div",
    { class: "formular" },
    keine,
    elternListe,
    hinzufuegen,
  );
  function neuesElternteil() {
    const block = elternBlock(eltern.length + 1, () => {
      eltern.splice(eltern.indexOf(block), 1);
      block.wurzel.remove();
      zeichneEltern();
    });
    eltern.push(block);
    elternListe.append(block.wurzel);
    zeichneEltern();
    block.wurzel.querySelector("input[type=text]")?.focus();
  }
  function zeichneEltern() {
    keine.hidden = eltern.length > 0;
    hinzufuegen.hidden = eltern.length >= 4;
  }
  const umschalten = () => {
    selbstFeld.hidden = art.wert !== "selbst";
    elternBereich.hidden = art.wert !== "eltern";
    benutzername.eingabe.toggleAttribute("required", art.wert === "selbst");
  };
  const antwortOptionen = [
    ["eltern", "Eltern antworten"],
    ["selbst", "Person antwortet selbst"],
  ].flatMap(([wert, text]) => {
    const id = neueId("antwort-option");
    return [
      el("input", {
        type: "radio",
        id,
        name: gruppe,
        value: wert,
        checked: wert === art.wert,
        onchange: () => {
          art.wert = wert;
          umschalten();
        },
      }),
      el("label", { for: id }, icon("haken"), text),
    ];
  });
  neuesElternteil();
  umschalten();
  dialogFormular({
    titel: "Teilnehmende anlegen",
    beschreibung:
      "Du legst fest, wer antwortet: die Eltern oder die Person selbst. Neue Konten erhalten ein Startpasswort.",
    felder: [
      vorname.wurzel,
      nachname.wurzel,
      rang.wurzel,
      el(
        "div",
        { class: "feld" },
        el("span", { class: "legende" }, "Wer antwortet?"),
        el(
          "div",
          { class: "seg", role: "radiogroup", "aria-label": "Wer antwortet?" },
          antwortOptionen,
        ),
      ),
      selbstFeld,
      elternBereich,
    ],
    ok: "Anlegen",
    senden: () =>
      anfrage("POST", `${basis(einheit)}/teilnehmende`, {
        vorname: vorname.eingabe.value.trim(),
        nachname: nachname.eingabe.value.trim(),
        ...(rang.eingabe.value ? { rangId: rang.eingabe.value } : {}),
        antwort:
          art.wert === "selbst"
            ? { art: "selbst", benutzername: benutzername.eingabe.value.trim() }
            : { art: "eltern", eltern: eltern.map((e) => e.wert()) },
      }),
    danach: (antwort) => {
      zustand.fokus = antwort.id;
      neu();
      ctx.melde("Die Person ist angelegt.");
      startpasswoerter(
        antwort.konten,
        ctx,
        "Gib die Startpasswörter sicher weiter.",
      );
    },
  });
}

function elternHinzufuegen(t, einheit, ctx, neu, fertig) {
  const block = elternBlock(1, () => {});
  // Das einzelne Formular braucht kein «Entfernen»
  block.wurzel.querySelector("button")?.remove();
  dialogFormular({
    titel: "Eltern hinzufügen",
    beschreibung: `Ein weiteres Elternteil, das für «${vollerName(t)}» antwortet.`,
    felder: [block.wurzel],
    ok: "Hinzufügen",
    senden: () =>
      anfrage("POST", `${basis(einheit)}/teilnehmende/${t.id}/eltern`, {
        eltern: block.wert(),
      }),
    danach: (antwort) => {
      zustand.fokus = t.id;
      neu();
      ctx.melde("Elternteil ist hinzugefügt.");
      startpasswoerter(
        [antwort],
        ctx,
        `Gib das Startpasswort für «${antwort.benutzername}» sicher weiter.`,
      );
      fertig();
    },
  });
}

function kontoWechsel(t, einheit, ctx, neu, fertig) {
  const benutzername = feld({
    label: "Benutzername der Person",
    hilfe: BENUTZERNAME_HILFE,
    maxlength: 64,
    autocapitalize: "none",
    autocomplete: "off",
    spellcheck: "false",
    required: true,
  });
  dialogFormular({
    titel: "Konto aufs Kind übertragen",
    beschreibung: `«${vollerName(t)}» bekommt ein eigenes Konto und antwortet danach selbst. Die Verknüpfung der Eltern fällt weg: Sie sehen die Person nicht mehr. Beides geschieht in einem Schritt.`,
    felder: [benutzername.wurzel],
    ok: "Konto übertragen",
    gefaehrlich: true,
    senden: () =>
      anfrage("POST", `${basis(einheit)}/teilnehmende/${t.id}/konto-wechsel`, {
        benutzername: benutzername.eingabe.value.trim(),
      }),
    danach: (antwort) => {
      zustand.fokus = t.id;
      neu();
      ctx.melde(`«${vollerName(t)}» antwortet jetzt mit eigenem Konto.`);
      startpasswoerter(
        [antwort],
        ctx,
        `Gib das Startpasswort für «${antwort.benutzername}» sicher weiter.`,
      );
      fertig();
    },
  });
}

function aktivSetzen(t, aktiv, einheit, ctx, neu, fertig = () => {}) {
  bestaetigen({
    titel: aktiv ? "Person aktiv setzen" : "Person inaktiv setzen",
    beschreibung: aktiv
      ? `«${vollerName(t)}» antwortet wieder auf Termine.`
      : `«${vollerName(t)}» bleibt erhalten, antwortet aber nicht mehr auf Termine und taucht in Anmeldungen nicht mehr auf.`,
    ok: aktiv ? "Aktiv setzen" : "Inaktiv setzen",
    gefaehrlich: !aktiv,
    aktion: () =>
      anfrage("PATCH", `${basis(einheit)}/teilnehmende/${t.id}`, { aktiv }),
    danach: () => {
      zustand.fokus = t.id;
      neu();
      ctx.melde(
        aktiv
          ? `«${vollerName(t)}» ist aktiv.`
          : `«${vollerName(t)}» ist inaktiv.`,
      );
      fertig();
    },
  });
}

// Seitenblatt: Angaben ändern und die Konten der Person mit ihren Aktionen
function bearbeiten(t, einheit, daten, ctx, neu) {
  const vorname = feld({
    label: "Vorname",
    wert: t.vorname,
    maxlength: 100,
    required: true,
  });
  const nachname = feld({
    label: "Nachname",
    wert: t.nachname,
    maxlength: 100,
    required: true,
  });
  const rang = raengeAuswahl(
    raengeVomTyp(daten.raenge, einheit.typ),
    t.rang?.id ?? "",
    "Rang",
  );
  const formularId = neueId("teilnehmende-formular");
  const fehler = el("p", {
    class: "hinweis hinweis--fehler",
    role: "alert",
    hidden: true,
    tabindex: "-1",
  });
  const formular = el(
    "form",
    {
      class: "formular",
      id: formularId,
      novalidate: true,
      onsubmit: (e) => e.preventDefault(),
    },
    el("h3", {}, "Angaben"),
    vorname.wurzel,
    nachname.wurzel,
    rang.wurzel,
    fehler,
  );
  const schliesse = () => blatt.close();
  const konten = t.konten.length
    ? el(
        "ul",
        { class: "konten-liste" },
        t.konten.map((k) =>
          el(
            "li",
            { class: "karte" },
            el(
              "div",
              {},
              el("span", { class: "name" }, k.name),
              el(
                "span",
                { class: "mini leise" },
                `${k.art === "selbst" ? "Eigenes Konto" : "Eltern"} · ${k.benutzername}`,
              ),
            ),
            el("ul", { class: "chips" }, zustandsChips(k)),
            k.gemeinsam &&
              el(
                "p",
                { class: "hilfe" },
                "Dieses Konto gehört auch zu einer anderen Einheit.",
              ),
            el(
              "div",
              { class: "aktionen" },
              ...kontoMenueEintraege(k, einheit, ctx, neu, schliesse)
                .filter(Boolean)
                .map((e) =>
                  knopf(e.text, {
                    klein: true,
                    art: e.gefaehrlich ? "gefahr" : undefined,
                    kontext: k.name,
                    onclick: e.onclick,
                  }),
                ),
            ),
          ),
        ),
      )
    : el(
        "div",
        { class: "hinweis hinweis--warn" },
        el(
          "span",
          {},
          "Keine Eltern: Für diese Person antwortet niemand. Füge Eltern hinzu oder lege ein eigenes Konto an.",
        ),
      );
  const aktionen = [
    !hatSelbst(t) &&
      knopf("Eltern hinzufügen", {
        symbol: "plus",
        onclick: () => elternHinzufuegen(t, einheit, ctx, neu, schliesse),
      }),
    !hatSelbst(t) &&
      knopf("Konto aufs Kind übertragen", {
        symbol: "schluessel",
        onclick: () => kontoWechsel(t, einheit, ctx, neu, schliesse),
      }),
    t.aktiv
      ? knopf("Inaktiv setzen", {
          onclick: () => aktivSetzen(t, false, einheit, ctx, neu, schliesse),
        })
      : knopf("Aktiv setzen", {
          onclick: () => aktivSetzen(t, true, einheit, ctx, neu, schliesse),
        }),
  ];
  const blatt = seitenblatt({
    titel: vollerName(t),
    untertitel: t.aktiv ? "Aktiv" : "Inaktiv",
    inhalt: [
      formular,
      el("div", { class: "abschnitt" }, el("h3", {}, "Konten"), konten),
      el(
        "div",
        { class: "abschnitt" },
        el("h3", {}, "Weitere Aktionen"),
        el("div", { class: "aktionen" }, aktionen),
      ),
    ],
    fusszeile: [
      knopf("Abbrechen", { onclick: schliesse }),
      el(
        "button",
        { type: "submit", form: formularId, class: "knopf knopf--haupt" },
        "Speichern",
      ),
    ],
  });
  formular.addEventListener("submit", async () => {
    fehler.hidden = true;
    const body = {};
    if (vorname.eingabe.value.trim() !== t.vorname) {
      body.vorname = vorname.eingabe.value.trim();
    }
    if (nachname.eingabe.value.trim() !== t.nachname) {
      body.nachname = nachname.eingabe.value.trim();
    }
    if (rang.eingabe.value !== (t.rang?.id ?? "")) {
      body.rangId = rang.eingabe.value || null;
    }
    if (!vorname.eingabe.value.trim() || !nachname.eingabe.value.trim()) {
      fehler.textContent = "Bitte Vor- und Nachname ausfüllen.";
      fehler.hidden = false;
      fehler.focus();
      return;
    }
    if (Object.keys(body).length === 0) {
      schliesse();
      return;
    }
    try {
      await anfrage("PATCH", `${basis(einheit)}/teilnehmende/${t.id}`, body);
    } catch (f) {
      fehler.textContent = fehlertext(f);
      fehler.hidden = false;
      fehler.focus();
      return;
    }
    zustand.fokus = t.id;
    schliesse();
    neu();
    ctx.melde("Gespeichert.");
  });
}

function zeichne(bereich, ctx, einheit, daten, neu) {
  ctx.kopfAktion(
    knopf("Teilnehmende anlegen", {
      art: "haupt",
      symbol: "plus",
      onclick: () => anlegen(einheit, daten, ctx, neu),
    }),
  );
  const alle = daten.teilnehmende;
  const aktive = alle.filter((t) => t.aktiv);
  const ohneKonto = aktive.filter((t) => t.konten.length === 0).length;
  const offene = aktive
    .flatMap((t) => t.konten)
    .filter((k) => k.startpasswort && !k.startpasswort.abgelaufen).length;
  const abgelaufen = aktive
    .flatMap((t) => t.konten)
    .filter((k) => k.startpasswort?.abgelaufen).length;
  const hinweis = aufgabenHinweis([
    ohneKonto > 0 &&
      `${mehrzahl(ohneKonto, "Person hat", "Personen haben")} keine Eltern und kein eigenes Konto: Es antwortet niemand.`,
    offene > 0 &&
      `${mehrzahl(offene, "Konto hat", "Konten haben")} noch ein offenes Startpasswort.`,
    abgelaufen > 0 &&
      `${mehrzahl(abgelaufen, "Startpasswort ist", "Startpasswörter sind")} abgelaufen: Erzeuge ein neues, sonst kommt niemand hinein.`,
  ]);

  const passt = (t, wert) => {
    if (wert === "ohne") return t.aktiv && t.konten.length === 0;
    if (wert === "eltern") return t.konten.some((k) => k.art === "eltern");
    if (wert === "selbst") return hatSelbst(t);
    if (wert === "inaktiv") return !t.aktiv;
    return true;
  };
  const liste = el("div", {});
  const zaehler = el("p", { class: "klein leise", role: "status" });
  const suchId = neueId("suche");
  const suche = el("input", {
    id: suchId,
    class: "eingabe",
    type: "search",
    placeholder: "Name suchen",
    autocomplete: "off",
    value: zustand.frage,
  });
  const seiten = seitenwahl({ beiWechsel: zeichneListe });
  const filter = filterGruppe({
    beschriftung: "Filter",
    eintraege: FILTER.map(([wert, text]) => ({
      wert,
      text,
      n: alle.filter((t) => passt(t, wert)).length,
    })),
    wert: zustand.filter,
    beiAenderung: (wert) => {
      zustand.filter = wert;
      seiten.anfang();
      zeichneListe();
    },
  });

  function zeichneListe() {
    const frage = zustand.frage.trim().toLowerCase();
    const treffer = alle.filter(
      (t) =>
        passt(t, zustand.filter) && vollerName(t).toLowerCase().includes(frage),
    );
    const [von, bis] = seiten.fenster(treffer.length);
    zaehler.textContent =
      treffer.length === alle.length
        ? mehrzahl(alle.length, "Person", "Personen")
        : `${treffer.length} von ${alle.length} Personen`;
    if (treffer.length === 0) {
      liste.replaceChildren(
        el(
          "p",
          { class: "leer" },
          alle.length === 0
            ? "Diese Einheit hat noch keine Teilnehmenden."
            : "Keine Person passt zu Suche und Filter.",
        ),
      );
      return;
    }
    const { wurzel } = tabelle({
      beschriftung: "Teilnehmende der Einheit",
      spalten: ["Person", "Rang", "Konten", "Zustand", "Aktionen"],
      zeilen: treffer.slice(von, bis).map((t) => {
        const offen = t.konten.filter(
          (k) => k.startpasswort && !k.startpasswort.abgelaufen,
        ).length;
        return el(
          "tr",
          { class: t.aktiv ? undefined : "inaktiv", "data-fokus": t.id },
          el(
            "th",
            { scope: "row" },
            el("span", { class: "name" }, vollerName(t)),
          ),
          el(
            "td",
            {},
            t.rang
              ? el(
                  "span",
                  { class: "rang-zelle" },
                  abzeichen(
                    daten.raenge.find((r) => r.id === t.rang.id),
                    "k",
                  ),
                  t.rang.name,
                )
              : el("span", { class: "leise" }, "–"),
          ),
          el(
            "td",
            {},
            t.konten.length === 0
              ? el(
                  "ul",
                  { class: "chips" },
                  chip("Keine Eltern", "warn", "warnung"),
                )
              : el(
                  "ul",
                  { class: "chips" },
                  t.konten.map((k) =>
                    chip(
                      `${k.art === "selbst" ? "Eigenes Konto" : "Eltern"}: ${k.benutzername}`,
                      k.deaktiviert ? "fehler" : undefined,
                      k.deaktiviert ? "sperre" : false,
                    ),
                  ),
                ),
          ),
          el(
            "td",
            {},
            el(
              "ul",
              { class: "chips" },
              !t.aktiv && chip("Inaktiv", undefined, "schliessen"),
              offen > 0 &&
                chip(
                  mehrzahl(
                    offen,
                    "Startpasswort offen",
                    "Startpasswörter offen",
                  ),
                  "warn",
                  "schluessel",
                ),
              t.aktiv && offen === 0 && chip("Aktiv", "ok"),
            ),
          ),
          aktionenZelle(
            knopf("Bearbeiten", {
              klein: true,
              symbol: "bearbeiten",
              kontext: vollerName(t),
              onclick: () => bearbeiten(t, einheit, daten, ctx, neu),
            }),
            menue(vollerName(t), [
              !hatSelbst(t) && {
                text: "Eltern hinzufügen",
                onclick: () =>
                  elternHinzufuegen(t, einheit, ctx, neu, () => {}),
              },
              !hatSelbst(t) && {
                text: "Konto aufs Kind übertragen",
                onclick: () => kontoWechsel(t, einheit, ctx, neu, () => {}),
              },
              t.aktiv
                ? {
                    text: "Inaktiv setzen",
                    gefaehrlich: true,
                    onclick: () => aktivSetzen(t, false, einheit, ctx, neu),
                  }
                : {
                    text: "Aktiv setzen",
                    onclick: () => aktivSetzen(t, true, einheit, ctx, neu),
                  },
            ]),
          ),
        );
      }),
    });
    liste.replaceChildren(wurzel);
    if (zustand.fokus) {
      const ziel = liste.querySelector(`[data-fokus="${zustand.fokus}"]`);
      if (ziel) {
        (ziel.querySelector("button, summary") ?? ziel).focus();
        zustand.fokus = null;
      }
    }
  }

  suche.addEventListener("input", () => {
    zustand.frage = suche.value;
    seiten.anfang();
    zeichneListe();
  });
  zeichneListe();
  // append schreibt null als Text: nur echte Knoten übergeben
  bereich.append(
    ...[hinweis].filter(Boolean),
    el(
      "div",
      { class: "werkzeuge" },
      el(
        "div",
        { class: "suche" },
        el("label", { class: "nur-leser", for: suchId }, "Teilnehmende suchen"),
        icon("lupe"),
        suche,
      ),
      filter.wurzel,
    ),
    zaehler,
    liste,
    seiten.wurzel,
  );
}
