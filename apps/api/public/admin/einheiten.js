import { anfrage, fehlertext } from "./api.js";
import {
  aktionenZelle,
  ankreuzen,
  auswahl,
  bestaetigen,
  chip,
  dialogFormular,
  el,
  feld,
  filterGruppe,
  geheimnisDialog,
  gruppe,
  icon,
  knopf,
  neueId,
  seitenblatt,
  tabelle,
  zeit,
} from "./dom.js";
import { BENUTZERNAME_HILFE, mehrzahl } from "./konten.js";
import { abzeichen } from "./raenge.js";
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

// Bezirke umbenennen oder löschen; löschen geht nur ohne Einheiten, sonst nennt die API den Grund
function bezirkeVerwalten(daten, ctx, neu) {
  const blatt = seitenblatt({
    titel: "Bezirke",
    untertitel:
      "Umbenennen geht immer. Löschen geht nur, solange der Bezirk keine Einheit hat.",
    inhalt:
      daten.bezirke.length === 0
        ? el("p", { class: "leer" }, "Es gibt noch keinen Bezirk.")
        : tabelle({
            beschriftung: "Bezirke",
            spalten: ["Bezirk", "Aktionen"],
            zeilen: daten.bezirke.map((b) =>
              el(
                "tr",
                {},
                el("th", { scope: "row" }, b.name),
                aktionenZelle(
                  knopf("Umbenennen", {
                    klein: true,
                    symbol: "bearbeiten",
                    kontext: b.name,
                    onclick: () => bezirkUmbenennen(b, ctx, neu, blatt),
                  }),
                  knopf("Löschen", {
                    klein: true,
                    art: "gefahr",
                    symbol: "papierkorb",
                    kontext: b.name,
                    onclick: () => bezirkLoeschen(b, ctx, neu, blatt),
                  }),
                ),
              ),
            ),
          }).wurzel,
    fusszeile: [knopf("Schliessen", { onclick: () => blatt.close() })],
  });
}

function bezirkUmbenennen(bezirk, ctx, neu, blatt) {
  const name = feld({
    label: "Name des Bezirks",
    maxlength: 100,
    required: true,
    wert: bezirk.name,
  });
  dialogFormular({
    titel: `Bezirk «${bezirk.name}» umbenennen`,
    felder: [name.wurzel],
    ok: "Speichern",
    senden: () =>
      anfrage("PATCH", `/api/v1/admin/bezirke/${bezirk.id}`, {
        name: name.eingabe.value.trim(),
      }),
    danach: () => {
      blatt.close();
      neu();
      ctx.melde("Der Bezirk ist umbenannt.");
    },
  });
}

function bezirkLoeschen(bezirk, ctx, neu, blatt) {
  bestaetigen({
    titel: `Bezirk «${bezirk.name}» löschen?`,
    beschreibung:
      "Der Bezirk wird gelöscht. Das geht nur, wenn er keine Einheit hat.",
    ok: "Löschen",
    aktion: () => anfrage("DELETE", `/api/v1/admin/bezirke/${bezirk.id}`),
    danach: () => {
      blatt.close();
      neu();
      ctx.melde("Der Bezirk ist gelöscht.");
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

// Logo der Einheit: sehen, ersetzen oder entfernen (Kommando, Stellvertretungen, Kantonsadmin)
function logoAbschnitt(e, ctx, neu, schliesse) {
  const dateiId = neueId("logo-datei");
  const datei = el("input", {
    id: dateiId,
    type: "file",
    accept: "image/svg+xml,image/png,.svg,.png",
  });
  const fehler = el("p", {
    class: "hinweis hinweis--fehler",
    role: "alert",
    tabindex: "-1",
    hidden: true,
  });
  const sende = async (aufgabe, meldung) => {
    fehler.hidden = true;
    try {
      await aufgabe();
    } catch (f) {
      fehler.textContent = fehlertext(f);
      fehler.hidden = false;
      fehler.focus();
      return;
    }
    schliesse();
    await ctx.einheitenNeu();
    neu();
    ctx.melde(meldung);
  };
  return el(
    "div",
    { class: "abschnitt" },
    el("h3", {}, "Logo"),
    e.logoUrl
      ? el("img", {
          src: e.logoUrl,
          alt: `Logo von ${e.name}`,
          width: 96,
          height: 96,
        })
      : el("p", { class: "leise" }, "Kein Logo hinterlegt."),
    el(
      "div",
      { class: "feld" },
      el("label", { for: dateiId }, "Bild (SVG oder PNG)"),
      datei,
      el(
        "p",
        { class: "hilfe" },
        "Quadratisch, bei PNG mindestens 128 × 128 Pixel, höchstens 500 KB. Der Server prüft die Datei und bereinigt ein SVG.",
      ),
    ),
    fehler,
    knopf("Logo hochladen", {
      onclick: () => {
        if (!datei.files?.length) {
          fehler.textContent = "Bitte ein Bild wählen.";
          fehler.hidden = false;
          fehler.focus();
          return;
        }
        sende(
          () =>
            anfrage(
              "PUT",
              `/api/v1/admin/einheiten/${e.id}/logo`,
              datei.files[0],
            ),
          "Logo ist gespeichert.",
        );
      },
    }),
    e.logoUrl &&
      knopf("Logo entfernen", {
        onclick: () =>
          sende(
            () => anfrage("DELETE", `/api/v1/admin/einheiten/${e.id}/logo`),
            "Logo ist entfernt.",
          ),
      }),
  );
}

// Terminkalender (Lodur) und Anmeldung: Link setzen, ersetzen oder entfernen, und wählen, für welche Arten von Terminen die Anmeldung angeboten wird. Die Abschnitte laden ihren Stand selbst und zeichnen sich nach jeder Änderung neu; `geaendert.wert` sagt dem Blatt, dass die Liste der Einheiten beim Schliessen neu geladen werden muss.
function lodurAbschnitte(e, ctx, geaendert) {
  const basis = `/api/v1/admin/einheiten/${e.id}`;
  const linkBlock = el(
    "div",
    { class: "abschnitt" },
    el("h3", {}, "Terminkalender (Lodur)"),
    el("p", { class: "leise" }, "Lädt …"),
  );
  const artenBlock = el("div", { class: "abschnitt" });
  const neuerFehler = () =>
    el("p", {
      class: "hinweis hinweis--fehler",
      role: "alert",
      tabindex: "-1",
      hidden: true,
    });
  const linkFehler = neuerFehler();
  const artenFehler = neuerFehler();
  const zeigeFehler = (feldFehler, f) => {
    feldFehler.textContent = typeof f === "string" ? f : fehlertext(f);
    feldFehler.hidden = false;
    feldFehler.focus();
  };

  function linkTeil(stand) {
    const link = feld({
      label: stand.gesetzt ? "Link ersetzen" : "Link zur Terminliste",
      maxlength: 4096,
      autocomplete: "off",
      autocapitalize: "none",
      spellcheck: "false",
      hilfe:
        "Der ganze Link zur Übungsliste der Einheit in Lodur; er endet auf «index.php?modul=13&what=10&year=2026». Die Jahreszahl im Link stellt der Sync bei jedem Abruf selbst ein. Der Link bleibt geheim: Danach zeigt die Verwaltung nur den Host.",
    });
    return [
      el(
        "ul",
        { class: "chips" },
        syncChips({
          lodurHinterlegt: stand.gesetzt,
          syncFehler: stand.syncFehler,
          syncOkAm: stand.syncOkAm,
        }),
      ),
      stand.maskiert && el("p", {}, `Hinterlegt: ${stand.maskiert}`),
      el(
        "p",
        { class: "hilfe" },
        "Der Sync läuft von selbst alle 15 Minuten; einen manuellen Sync gibt es nicht.",
      ),
      link.wurzel,
      linkFehler,
      el(
        "div",
        { class: "aktionen" },
        stand.gesetzt &&
          knopf("Link entfernen", {
            art: "gefahr",
            onclick: () =>
              bestaetigen({
                titel: "Link entfernen?",
                beschreibung:
                  "Der Sync holt danach keine Termine mehr. Die bisherigen Termine bleiben im Kalender.",
                ok: "Entfernen",
                aktion: () => anfrage("DELETE", `${basis}/lodur`),
                danach: () => {
                  geaendert.wert = true;
                  ctx.melde("Der Link ist entfernt.");
                  lade();
                },
              }),
          }),
        knopf(stand.gesetzt ? "Link ersetzen" : "Link speichern", {
          art: "haupt",
          onclick: async () => {
            const url = link.eingabe.value.trim();
            if (!url) {
              zeigeFehler(linkFehler, "Bitte den Link einfügen.");
              return;
            }
            linkFehler.hidden = true;
            try {
              await anfrage("PUT", `${basis}/lodur`, { url });
            } catch (f) {
              zeigeFehler(linkFehler, f);
              return;
            }
            geaendert.wert = true;
            ctx.melde(
              "Der Link ist gespeichert. Der Sync holt die Termine innerhalb von 15 Minuten.",
            );
            lade();
          },
        }),
      ),
    ];
  }

  function artenTeil(stand) {
    const kopf = el("h3", {}, "Anmeldung");
    if (stand.arten.length === 0) {
      return [
        kopf,
        el(
          "p",
          { class: "leise" },
          "Noch keine Termine gefunden. Sobald der Sync Termine geholt hat, erscheinen hier ihre Arten (Sitzung, Übung, Kurs …) und du wählst, für welche man sich anmelden kann.",
        ),
      ];
    }
    const wahlen = stand.arten.map((a) => ({
      art: a.art,
      wahl: ankreuzen({
        label: `${a.art} (${mehrzahl(a.anzahl, "Termin", "Termine")})`,
        gewaehlt: a.anmeldbar,
        wert: a.art,
      }),
    }));
    return [
      kopf,
      !stand.entschieden &&
        el(
          "p",
          { class: "hinweis hinweis--warn" },
          "Noch nicht festgelegt: Solange du nichts speicherst, kann man sich für keinen Termin anmelden. Alle Termine bleiben im Kalender sichtbar.",
        ),
      gruppe(
        "Anmeldung anbieten für",
        el(
          "div",
          {},
          wahlen.map((w) => w.wahl.wurzel),
        ),
      ),
      el(
        "p",
        { class: "hilfe" },
        "Nur Termine der gewählten Arten haben eine Anmeldung, Erinnerungen und eine Auswertung. Die übrigen bleiben im Kalender sichtbar, ohne Anmeldung. Bestehende Antworten bleiben gespeichert.",
      ),
      artenFehler,
      el(
        "div",
        { class: "aktionen" },
        knopf("Auswahl speichern", {
          art: "haupt",
          onclick: async () => {
            artenFehler.hidden = true;
            try {
              await anfrage("PUT", `${basis}/anmelde-arten`, {
                arten: wahlen
                  .filter((w) => w.wahl.eingabe.checked)
                  .map((w) => w.art),
              });
            } catch (f) {
              // Eine Art, die es nicht mehr gibt: Liste neu laden, die Meldung bleibt stehen
              await lade();
              zeigeFehler(artenFehler, f);
              return;
            }
            geaendert.wert = true;
            ctx.melde("Die Auswahl ist gespeichert.");
            lade();
          },
        }),
      ),
    ];
  }

  async function lade() {
    let link, arten;
    try {
      [link, arten] = await Promise.all([
        anfrage("GET", `${basis}/lodur`),
        anfrage("GET", `${basis}/anmelde-arten`),
      ]);
    } catch (f) {
      linkBlock.replaceChildren(
        el("h3", {}, "Terminkalender (Lodur)"),
        el(
          "p",
          { class: "hinweis hinweis--fehler", role: "alert" },
          fehlertext(f),
        ),
      );
      return;
    }
    linkFehler.hidden = true;
    artenFehler.hidden = true;
    linkBlock.replaceChildren(
      el("h3", {}, "Terminkalender (Lodur)"),
      ...linkTeil(link).filter(Boolean),
    );
    artenBlock.replaceChildren(...artenTeil(arten).filter(Boolean));
  }

  lade();
  return [linkBlock, artenBlock];
}

function details(e, ctx, neu) {
  const geaendert = { wert: false };
  const blatt = seitenblatt({
    titel: e.name,
    untertitel: `${TYPNAME[e.typ]} · Bezirk ${e.bezirk}`,
    // Link und Sync-Stand stehen auch in der Liste dahinter
    schliessen: async () => {
      if (!geaendert.wert) return;
      await ctx.einheitenNeu();
      neu();
    },
    inhalt: [
      el(
        "div",
        { class: "abschnitt" },
        el("h3", {}, "Kommando"),
        e.kommandant
          ? el(
              "p",
              {},
              e.kommandant.rang
                ? el(
                    "span",
                    { class: "rang-zelle" },
                    abzeichen(e.kommandant.rang, "k"),
                    e.kommandant.name,
                  )
                : e.kommandant.name,
            )
          : el("p", { class: "leise" }, "Kein Kommando eingetragen."),
        istKantonsadmin() &&
          knopf("Kommando übergeben", {
            symbol: "schluessel",
            onclick: () => uebergabe(e, ctx, neu, () => blatt.close()),
          }),
      ),
      logoAbschnitt(e, ctx, neu, () => blatt.close()),
      ...lodurAbschnitte(e, ctx, geaendert),
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
          knopf("Bezirke verwalten", {
            symbol: "bearbeiten",
            onclick: () => bezirkeVerwalten(daten, ctx, neu),
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
              e.logoUrl
                ? el("img", {
                    class: "einheit-logo",
                    src: e.logoUrl,
                    alt: `Logo von ${e.name}`,
                    width: 40,
                    height: 40,
                  })
                : icon("einheit"),
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
              ? el(
                  "span",
                  { class: "rang-zelle" },
                  abzeichen(e.kommandant.rang, "k"),
                  e.kommandant.name,
                )
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
