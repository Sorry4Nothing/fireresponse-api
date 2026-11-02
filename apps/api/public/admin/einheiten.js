import { anfrage, fehlertext } from "./api.js";
import {
  aktionenZelle,
  auswahl,
  chip,
  dialogFormular,
  el,
  feld,
  filterGruppe,
  geheimnisDialog,
  icon,
  knopf,
  neueId,
  seitenblatt,
  tabelle,
  zeit,
} from "./dom.js";
import { BENUTZERNAME_HILFE, mehrzahl } from "./konten.js";
import { istKantonsadmin, kontext, ROLLENNAME, TYPNAME } from "./kontext.js";

// Einheiten (Jugend- und Kinderfeuerwehr eines Bezirks): Der Kantonsadmin legt sie mit ihrer Kommandantin oder ihrem Kommandanten an und übergibt das Kommando; Kommando und Stellvertretungen sehen ihre Einheiten.

const zustand = { frage: "", filter: "alle", fokus: null };

const FILTER = [
  ["alle", "Alle"],
  ["jf", "Jugendfeuerwehr"],
  ["kf", "Kinderfeuerwehr"],
];

// Stand des Syncs mit dem Terminkalender: Zeitpunkt und Fehlercode; die Anzeige ersetzt keinen manuellen Sync
export function syncChips(e) {
  const liste = [];
  if (!e.lodurHinterlegt) {
    liste.push(chip("Kein Link hinterlegt", undefined, "info"));
  } else if (e.syncFehler) {
    liste.push(chip(`Sync-Fehler: ${e.syncFehler}`, "fehler", "warnung"));
  } else if (e.syncOkAm) {
    liste.push(chip(`Sync ok, ${zeit(e.syncOkAm)}`, "ok"));
  } else {
    liste.push(chip("Noch nicht synchronisiert", "warn", "uhr"));
  }
  return liste;
}

export function zeige(bereich, ctx) {
  zustand.frage = "";
  zustand.filter = "alle";
  zustand.fokus = null;
  ctx.lade(
    async () => {
      const [einheiten, bezirke] = await Promise.all([
        anfrage("GET", "/api/v1/admin/einheiten"),
        istKantonsadmin()
          ? anfrage("GET", "/api/v1/admin/bezirke")
          : { bezirke: [] },
      ]);
      return { einheiten: einheiten.einheiten, bezirke: bezirke.bezirke };
    },
    (daten, neu) => zeichne(bereich, ctx, daten, neu),
  );
}

function bezirkAnlegen(ctx, neu) {
  const name = feld({
    label: "Name des Bezirks",
    maxlength: 100,
    required: true,
    hilfe:
      "Zum Beispiel «Meilen». Jeder Bezirk kann eine Jugend- und eine Kinderfeuerwehr haben.",
  });
  dialogFormular({
    titel: "Bezirk anlegen",
    felder: [name.wurzel],
    ok: "Anlegen",
    senden: () =>
      anfrage("POST", "/api/v1/admin/bezirke", {
        name: name.eingabe.value.trim(),
      }),
    danach: () => {
      neu();
      ctx.melde("Der Bezirk ist angelegt.");
    },
  });
}

function einheitAnlegen(daten, ctx, neu) {
  if (daten.bezirke.length === 0) {
    ctx.melde("Lege zuerst einen Bezirk an.", "fehler");
    return;
  }
  const bezirk = auswahl({
    label: "Bezirk",
    optionen: daten.bezirke.map((b) => [b.id, b.name]),
    wert: daten.bezirke[0].id,
  });
  const typ = { wert: "jf" };
  const gruppe = neueId("einheit-typ");
  const typOptionen = Object.entries(TYPNAME).flatMap(([wert, text]) => {
    const id = neueId("typ-option");
    return [
      el("input", {
        type: "radio",
        id,
        name: gruppe,
        value: wert,
        checked: wert === typ.wert,
        onchange: () => {
          typ.wert = wert;
        },
      }),
      el("label", { for: id }, icon("haken"), text),
    ];
  });
  const name = feld({
    label: "Name der Einheit",
    maxlength: 100,
    required: true,
    hilfe: "Zum Beispiel «Jugendfeuerwehr Musterdorf».",
  });
  const vorname = feld({ label: "Vorname", maxlength: 100, required: true });
  const nachname = feld({ label: "Nachname", maxlength: 100, required: true });
  const benutzername = feld({
    label: "Benutzername",
    hilfe: BENUTZERNAME_HILFE,
    maxlength: 64,
    autocapitalize: "none",
    autocomplete: "off",
    spellcheck: "false",
    required: true,
  });
  const telefon = feld({
    label: "Telefon (optional)",
    typ: "tel",
    maxlength: 30,
    autocomplete: "off",
  });
  dialogFormular({
    titel: "Einheit anlegen",
    beschreibung:
      "Eine Einheit entsteht zusammen mit ihrer Kommandantin oder ihrem Kommandanten. Das neue Konto erhält ein Startpasswort.",
    felder: [
      bezirk.wurzel,
      el(
        "div",
        { class: "feld" },
        el("span", { class: "legende" }, "Art"),
        el(
          "div",
          { class: "seg", role: "radiogroup", "aria-label": "Art" },
          typOptionen,
        ),
      ),
      name.wurzel,
      el("h3", {}, "Kommando"),
      vorname.wurzel,
      nachname.wurzel,
      benutzername.wurzel,
      telefon.wurzel,
    ],
    ok: "Einheit anlegen",
    senden: () =>
      anfrage("POST", "/api/v1/admin/einheiten", {
        bezirkId: bezirk.eingabe.value,
        typ: typ.wert,
        name: name.eingabe.value.trim(),
        kommandant: {
          vorname: vorname.eingabe.value.trim(),
          nachname: nachname.eingabe.value.trim(),
          benutzername: benutzername.eingabe.value.trim(),
          ...(telefon.eingabe.value.trim()
            ? { telefon: telefon.eingabe.value.trim() }
            : {}),
        },
      }),
    danach: async (antwort) => {
      zustand.fokus = antwort.id;
      await ctx.einheitenNeu();
      neu();
      ctx.melde(`Die Einheit «${name.eingabe.value.trim()}» ist angelegt.`);
      geheimnisDialog({
        titel: "Startpasswort",
        beschreibung: `Gib das Startpasswort für «${antwort.kommandant.benutzername}» sicher weiter. Es gilt 7 Tage und steht nur in diesem Fenster; solange es offen ist, zeigt die Verwaltung es wieder an.`,
        wert: antwort.kommandant.startpasswort,
      });
    },
  });
}

// Übergabe: Die neue Kommandantin oder der neue Kommandant ist ein Konto, das schon eine Rolle in der Einheit hat (Stellvertretung oder Leitende); die bisherige Person bekommt eine neue Rolle
async function uebergabe(e, ctx, neu, fertig) {
  let personen;
  try {
    ({ personen } = await anfrage(
      "GET",
      `/api/v1/admin/einheiten/${e.id}/personen`,
    ));
  } catch (f) {
    ctx.melde(fehlertext(f), "fehler");
    return;
  }
  const kandidaten = personen.filter(
    (p) => p.rolle !== "kommandant" && !p.deaktiviert,
  );
  if (kandidaten.length === 0) {
    ctx.melde(
      "Lege zuerst eine Stellvertretung oder leitende Person an. Sie kann dann das Kommando übernehmen.",
      "fehler",
    );
    return;
  }
  const neue = auswahl({
    label: "Neue Kommandantin oder neuer Kommandant",
    optionen: kandidaten.map((p) => [
      p.id,
      `${p.name} (${ROLLENNAME[p.rolle]})`,
    ]),
    wert: kandidaten[0].id,
  });
  const rolle = { wert: "stellvertretung" };
  const gruppe = neueId("bisherige-rolle");
  const position = feld({
    label: "Position der Stellvertretung",
    typ: "number",
    wert: "1",
    min: 1,
    max: 99,
    inputmode: "numeric",
    hilfe:
      "Position 1 ist die erste Stellvertretung. Wer schon dort steht, rückt nach hinten.",
  });
  const umschalten = () => {
    position.wurzel.hidden = rolle.wert !== "stellvertretung";
  };
  const optionen = [
    ["stellvertretung", "Stellvertretung"],
    ["leitung", "Leitende Person"],
    ["keine", "Keine Rolle mehr"],
  ].flatMap(([wert, text]) => {
    const id = neueId("rolle-option");
    return [
      el("input", {
        type: "radio",
        id,
        name: gruppe,
        value: wert,
        checked: wert === rolle.wert,
        onchange: () => {
          rolle.wert = wert;
          umschalten();
        },
      }),
      el("label", { for: id }, icon("haken"), text),
    ];
  });
  umschalten();
  const bisher = personen.find((p) => p.rolle === "kommandant");
  dialogFormular({
    titel: "Kommando übergeben",
    beschreibung: `Die Einheit «${e.name}» hat immer genau eine Kommandantin oder einen Kommandanten. Die Übergabe tauscht die Rollen in einem Schritt.`,
    felder: [
      neue.wurzel,
      el(
        "div",
        { class: "feld" },
        el(
          "span",
          { class: "legende" },
          `Neue Rolle von ${bisher?.name ?? "der bisherigen Person"}`,
        ),
        el(
          "div",
          {
            class: "seg",
            role: "radiogroup",
            "aria-label": "Neue Rolle der bisherigen Person",
          },
          optionen,
        ),
      ),
      position.wurzel,
    ],
    ok: "Übergeben",
    gefaehrlich: true,
    senden: () =>
      anfrage("POST", `/api/v1/admin/einheiten/${e.id}/kommando`, {
        neuerKommandantId: neue.eingabe.value,
        bisherigeRolle:
          rolle.wert === "stellvertretung"
            ? {
                typ: "stellvertretung",
                reihenfolge: Number(position.eingabe.value) || 1,
              }
            : { typ: rolle.wert },
      }),
    danach: async () => {
      await ctx.einheitenNeu();
      neu();
      ctx.melde("Das Kommando ist übergeben.");
      fertig();
    },
  });
}

function details(e, ctx, neu) {
  const blatt = seitenblatt({
    titel: e.name,
    untertitel: `${TYPNAME[e.typ]} · Bezirk ${e.bezirk}`,
    inhalt: [
      el(
        "div",
        { class: "abschnitt" },
        el("h3", {}, "Kommando"),
        e.kommandant
          ? el("p", {}, e.kommandant.name)
          : el("p", { class: "leise" }, "Kein Kommando eingetragen."),
        istKantonsadmin() &&
          knopf("Kommando übergeben", {
            symbol: "schluessel",
            onclick: () => uebergabe(e, ctx, neu, () => blatt.close()),
          }),
      ),
      el(
        "div",
        { class: "abschnitt" },
        el("h3", {}, "Terminkalender (Lodur)"),
        el("ul", { class: "chips" }, syncChips(e)),
        el(
          "p",
          { class: "hilfe" },
          "Hier steht nur der Stand des Syncs. Er läuft von selbst; einen manuellen Sync gibt es nicht.",
        ),
      ),
      el(
        "div",
        { class: "abschnitt" },
        el("h3", {}, "Bestand"),
        el(
          "p",
          {},
          mehrzahl(
            e.teilnehmende,
            "aktive teilnehmende Person",
            "aktive teilnehmende Personen",
          ),
        ),
      ),
    ],
    fusszeile: [
      knopf("Schliessen", { onclick: () => blatt.close() }),
      e.id !== kontext.aktiveId &&
        knopf("Diese Einheit verwalten", {
          art: "haupt",
          onclick: () => {
            blatt.close();
            ctx.waehle(e.id);
          },
        }),
    ],
  });
}

function zeichne(bereich, ctx, daten, neu) {
  ctx.kopfAktion(
    ...(istKantonsadmin()
      ? [
          knopf("Bezirk anlegen", {
            symbol: "plus",
            onclick: () => bezirkAnlegen(ctx, neu),
          }),
          knopf("Einheit anlegen", {
            art: "haupt",
            symbol: "plus",
            onclick: () => einheitAnlegen(daten, ctx, neu),
          }),
        ]
      : []),
  );
  const alle = daten.einheiten;
  const liste = el("div", {});
  const zaehler = el("p", { class: "klein leise", role: "status" });
  const suchId = neueId("suche");
  const suche = el("input", {
    id: suchId,
    class: "eingabe",
    type: "search",
    placeholder: "Name oder Bezirk",
    autocomplete: "off",
    value: zustand.frage,
  });
  const filter = filterGruppe({
    beschriftung: "Art",
    eintraege: FILTER.map(([wert, text]) => ({
      wert,
      text,
      n: alle.filter((e) => wert === "alle" || e.typ === wert).length,
    })),
    wert: zustand.filter,
    beiAenderung: (wert) => {
      zustand.filter = wert;
      zeichneListe();
    },
  });

  function zeichneListe() {
    const frage = zustand.frage.trim().toLowerCase();
    const treffer = alle.filter(
      (e) =>
        (zustand.filter === "alle" || e.typ === zustand.filter) &&
        `${e.name} ${e.bezirk}`.toLowerCase().includes(frage),
    );
    zaehler.textContent =
      treffer.length === alle.length
        ? mehrzahl(alle.length, "Einheit", "Einheiten")
        : `${treffer.length} von ${alle.length} Einheiten`;
    if (treffer.length === 0) {
      liste.replaceChildren(
        el(
          "p",
          { class: "leer" },
          alle.length === 0
            ? istKantonsadmin()
              ? "Es gibt noch keine Einheit. Lege zuerst einen Bezirk und dann eine Einheit an."
              : "Dein Konto hat keine Einheit."
            : "Keine Einheit passt zu Suche und Filter.",
        ),
      );
      return;
    }
    const { wurzel } = tabelle({
      beschriftung: "Einheiten",
      spalten: [
        "Einheit",
        "Bezirk",
        "Kommando",
        ["Aktive", "zahl"],
        "Sync",
        "Aktionen",
      ],
      zeilen: treffer.map((e) =>
        el(
          "tr",
          {
            class: e.id === kontext.aktiveId ? "gewaehlt" : undefined,
            "data-fokus": e.id,
          },
          el(
            "th",
            { scope: "row" },
            el(
              "div",
              { class: "wer" },
              icon("einheit"),
              el(
                "div",
                {},
                el("span", { class: "name" }, e.name),
                el("span", { class: "mini leise" }, TYPNAME[e.typ]),
                el(
                  "ul",
                  { class: "chips" },
                  e.id === kontext.aktiveId && chip("Gewählt", "ok"),
                  e.rolle &&
                    chip(`Deine Rolle: ${ROLLENNAME[e.rolle]}`, "stufe"),
                ),
              ),
            ),
          ),
          el("td", {}, e.bezirk),
          el(
            "td",
            {},
            e.kommandant
              ? e.kommandant.name
              : el("span", { class: "leise" }, "–"),
          ),
          el("td", { class: "zahl" }, String(e.teilnehmende)),
          el("td", {}, el("ul", { class: "chips" }, syncChips(e))),
          aktionenZelle(
            e.id !== kontext.aktiveId &&
              knopf("Verwalten", {
                klein: true,
                symbol: "einheit",
                kontext: e.name,
                onclick: () => ctx.waehle(e.id),
              }),
            knopf("Details", {
              klein: true,
              symbol: "info",
              kontext: e.name,
              onclick: () => details(e, ctx, neu),
            }),
          ),
        ),
      ),
    });
    liste.replaceChildren(wurzel);
    if (zustand.fokus) {
      const ziel = liste.querySelector(`[data-fokus="${zustand.fokus}"]`);
      (ziel?.querySelector("button") ?? ziel)?.focus();
      zustand.fokus = null;
    }
  }

  suche.addEventListener("input", () => {
    zustand.frage = suche.value;
    zeichneListe();
  });
  zeichneListe();
  bereich.append(
    el(
      "div",
      { class: "werkzeuge" },
      el(
        "div",
        { class: "suche" },
        el("label", { class: "nur-leser", for: suchId }, "Einheiten suchen"),
        icon("lupe"),
        suche,
      ),
      filter.wurzel,
    ),
    zaehler,
    liste,
  );
}
