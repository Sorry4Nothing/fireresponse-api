import { anfrage, fehlertext } from "./api.js";
import {
  aktionenZelle,
  ankreuzen,
  bestaetigen,
  chip,
  dialogFormular,
  el,
  feld,
  filterGruppe,
  geheimnisDialog,
  icon,
  avatar,
  knopf,
  neueId,
  seitenblatt,
  seitenwahl,
  tabelle,
  zeit,
} from "./dom.js";

const ROLLEN = [
  ["", "Keine"],
  ["leitung", "Leitung"],
  ["stufenleitung", "Stufenleitung"],
];
const ROLLENNAME = { leitung: "Leitung", stufenleitung: "Stufenleitung" };

// Suche und Filter überleben das Neuladen nach einer Aktion; fokus: Person, deren Zeile danach den Fokus bekommt
const zustand = { frage: "", filter: "alle", fokus: null };

export function zeige(bereich, ctx) {
  zustand.frage = "";
  zustand.filter = "alle";
  zustand.fokus = null;
  ctx.lade(
    () => anfrage("GET", "/api/v1/admin/personen"),
    (daten, neu) => zeichne(bereich, ctx, daten, neu),
  );
}

// Rollen-Editor: eine Gruppe von Optionsknöpfen je Stufe
function rollenFelder(stufen, rollen) {
  const aktuell = new Map(rollen.map((r) => [r.stufeId, r.typ]));
  const zeilen = stufen.map((stufe) => {
    const name = neueId("rolle");
    const gewaehlt = aktuell.get(stufe.id) ?? "";
    const optionen = ROLLEN.map(([wert, text]) => {
      const id = neueId("rolle-option");
      return {
        wert,
        eingabe: el("input", {
          type: "radio",
          id,
          name,
          value: wert,
          checked: wert === gewaehlt,
        }),
        label: el("label", { for: id }, icon("haken"), text),
      };
    });
    return {
      stufe,
      optionen,
      wurzel: el(
        "fieldset",
        { class: "rolle" },
        el("legend", {}, stufe.name),
        el(
          "div",
          { class: "seg" },
          optionen.flatMap((o) => [o.eingabe, o.label]),
        ),
      ),
    };
  });
  return {
    wurzel: el(
      "div",
      { class: "abschnitt" },
      el("h3", {}, "Stufenrollen"),
      zeilen.length
        ? zeilen.map((z) => z.wurzel)
        : el("p", { class: "hilfe" }, "Es gibt noch keine Stufen."),
    ),
    wert: () =>
      zeilen
        .map((z) => ({
          stufeId: z.stufe.id,
          typ: z.optionen.find((o) => o.eingabe.checked)?.wert ?? "",
        }))
        .filter((r) => r.typ),
  };
}

function kinderFelder(kinder, stufen, gewaehlt) {
  const stufenname = new Map(stufen.map((s) => [s.id, s.name]));
  const zaehler = el("span", { class: "klein leise" });
  const suchId = neueId("kind-suche");
  const zeilen = kinder.map((kind) => {
    const name = `${kind.vorname} ${kind.nachname}`;
    const box = ankreuzen({
      label: name,
      gewaehlt: gewaehlt.includes(kind.id),
      wert: kind.id,
    });
    box.wurzel.dataset.suche = name.toLowerCase();
    box.wurzel.append(
      el(
        "span",
        { class: "chip chip--stufe" },
        stufenname.get(kind.stufeId) ?? "ohne Stufe",
      ),
    );
    return box;
  });
  const anzahl = () => {
    const n = zeilen.filter((b) => b.eingabe.checked).length;
    zaehler.textContent = `${n} gewählt`;
  };
  const suche = el("input", {
    class: "eingabe",
    id: suchId,
    type: "search",
    placeholder: "Kind suchen",
    autocomplete: "off",
    oninput: () => {
      const frage = suche.value.trim().toLowerCase();
      for (const z of zeilen)
        z.wurzel.hidden = !z.wurzel.dataset.suche.includes(frage);
    },
  });
  const liste = el(
    "div",
    { class: "kinderliste", role: "group", "aria-label": "Kinder" },
    zeilen.map((z) => z.wurzel),
  );
  liste.addEventListener("change", anzahl);
  anzahl();
  return {
    wurzel: el(
      "div",
      { class: "abschnitt" },
      el("div", { class: "zeile" }, el("h3", {}, "Elternteil von"), zaehler),
      zeilen.length
        ? [
            el(
              "div",
              { class: "suche suche--voll" },
              el("label", { class: "nur-leser", for: suchId }, "Kind suchen"),
              icon("lupe"),
              suche,
            ),
            liste,
          ]
        : el("p", { class: "hilfe" }, "Es gibt noch keine Kinder."),
    ),
    wert: () =>
      zeilen.filter((b) => b.eingabe.checked).map((b) => b.eingabe.value),
  };
}

function anlegen(daten, ctx, neu) {
  const vorname = feld({ label: "Vorname", maxlength: 100, required: true });
  const nachname = feld({ label: "Nachname", maxlength: 100, required: true });
  const telefon = feld({
    label: "Telefon (optional)",
    typ: "tel",
    hilfe:
      "Nur für Stufenleitungen. Eltern, Leitende und Stufenleitung der Stufe sehen die Nummer bei den Kontakten. Leer lassen, um sie zu entfernen.",
    maxlength: 30,
    autocomplete: "off",
  });
  const benutzername = feld({
    label: "Benutzername",
    hilfe:
      "2 bis 64 Zeichen: Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich. Gross- und Kleinschreibung zählt nicht.",
    maxlength: 64,
    autocapitalize: "none",
    spellcheck: "false",
    required: true,
  });
  const admin = ankreuzen({ label: "Admin-Rechte" });
  const rollen = rollenFelder(daten.stufen, []);
  const kinder = kinderFelder(daten.kinder, daten.stufen, []);
  dialogFormular({
    titel: "Person anlegen",
    beschreibung:
      "Die Person erhält ein Startpasswort. Es bleibt in der Liste sichtbar, bis die Person es ersetzt hat.",
    felder: [
      vorname.wurzel,
      nachname.wurzel,
      telefon.wurzel,
      benutzername.wurzel,
      admin.wurzel,
      rollen.wurzel,
      kinder.wurzel,
    ],
    ok: "Anlegen",
    senden: () =>
      anfrage("POST", "/api/v1/admin/personen", {
        vorname: vorname.eingabe.value.trim(),
        nachname: nachname.eingabe.value.trim(),
        telefon: telefon.eingabe.value,
        benutzername: benutzername.eingabe.value.trim(),
        admin: admin.eingabe.checked,
        rollen: rollen.wert(),
        elternteilVon: kinder.wert(),
      }),
    danach: (antwort) => {
      neu();
      ctx.melde(`Person «${antwort.benutzername}» ist angelegt.`);
      geheimnisDialog({
        titel: "Startpasswort",
        beschreibung: `Gib das Startpasswort für «${antwort.benutzername}» sicher weiter. Es gilt 7 Tage und bleibt in der Liste sichtbar, bis die Person es ersetzt hat.`,
        wert: antwort.startpasswort,
      });
    },
  });
}

// fertig() schliesst das Seitenblatt nach einer geglückten Aktion, denn seine Angaben sind danach veraltet
function neuesStartpasswort(person, ctx, neu, fertig) {
  bestaetigen({
    titel: "Neues Startpasswort erzeugen",
    beschreibung: `«${person.name}» wird überall abgemeldet und muss beim nächsten Login ein neues Passwort wählen. Das Startpasswort gilt 7 Tage.`,
    ok: "Startpasswort erzeugen",
    aktion: () =>
      anfrage("POST", `/api/v1/admin/personen/${person.id}/startpasswort`),
    danach: (antwort) => {
      neu();
      ctx.melde(`Neues Startpasswort für «${person.name}» ist erzeugt.`);
      geheimnisDialog({
        titel: "Startpasswort",
        beschreibung: `Gib das Startpasswort für «${person.name}» sicher weiter. Es gilt 7 Tage und bleibt in der Liste sichtbar, bis die Person es ersetzt hat.`,
        wert: antwort.startpasswort,
      });
      fertig();
    },
  });
}

function umschalten(person, ctx, neu, fertig) {
  const deaktivieren = !person.deaktiviert;
  bestaetigen({
    titel: deaktivieren ? "Person deaktivieren" : "Person aktivieren",
    beschreibung: deaktivieren
      ? `«${person.name}» kann sich nicht mehr anmelden und wird überall abgemeldet.`
      : `«${person.name}» kann sich wieder anmelden.`,
    ok: deaktivieren ? "Deaktivieren" : "Aktivieren",
    gefaehrlich: deaktivieren,
    aktion: () =>
      anfrage(
        "POST",
        `/api/v1/admin/personen/${person.id}/${deaktivieren ? "deaktivieren" : "aktivieren"}`,
      ),
    danach: () => {
      zustand.fokus = person.id;
      neu();
      ctx.melde(
        deaktivieren
          ? `«${person.name}» ist deaktiviert.`
          : `«${person.name}» ist aktiviert.`,
      );
      fertig();
    },
  });
}

function faktorZuruecksetzen(person, ctx, neu, fertig) {
  bestaetigen({
    titel: "Zweiten Faktor zurücksetzen",
    beschreibung: `«${person.name}» muss den zweiten Faktor danach neu einrichten.`,
    ok: "Zurücksetzen",
    aktion: () =>
      anfrage(
        "POST",
        `/api/v1/admin/personen/${person.id}/zweiter-faktor-zuruecksetzen`,
      ),
    danach: () => {
      zustand.fokus = person.id;
      neu();
      ctx.melde(`Der zweite Faktor von «${person.name}» ist zurückgesetzt.`);
      fertig();
    },
  });
}

const leer = () => el("span", { class: "leise" }, "–");

// Restlaufzeit des Startpassworts in der grössten passenden Einheit
function restzeit(iso) {
  const min = Math.max(0, Math.floor((new Date(iso) - Date.now()) / 60000));
  if (min >= 2880) return `noch ${Math.floor(min / 1440)} Tage`;
  if (min >= 120) return `noch ${Math.floor(min / 60)} Std.`;
  return `noch ${min} Min.`;
}

// Abgelaufen: Der Wechsel ist offen und die Frist vorbei, die Person kommt nicht mehr hinein
const startpasswortAbgelaufen = (person) =>
  person.mussPasswortAendern &&
  Boolean(person.startpasswortGueltigBis) &&
  new Date(person.startpasswortGueltigBis) <= new Date();

const gueltigText = (iso) => ` gültig bis ${zeit(iso)} (${restzeit(iso)})`;

// Chips mit Symbol und Wort; «Aktiv» nur, wenn sonst nichts zu sagen ist
function statusChips(person) {
  const liste = [
    person.admin && chip("Admin", undefined, "stern"),
    person.zweiterFaktor && chip("Zweiter Faktor", "ok", "schild"),
    person.rollen.some((r) => r.typ === "stufenleitung") &&
      (person.telefon
        ? chip("Telefon hinterlegt", "ok", "telefon")
        : chip("Keine Telefonnummer", "warn", "telefon")),
    startpasswortAbgelaufen(person)
      ? chip(
          `Startpasswort abgelaufen am ${zeit(person.startpasswortGueltigBis)}`,
          "fehler",
          "uhr",
        )
      : person.mussPasswortAendern &&
        chip(
          person.startpasswort
            ? [
                "Startpasswort ",
                el("span", { class: "mono" }, person.startpasswort),
                gueltigText(person.startpasswortGueltigBis),
              ]
            : person.startpasswortGueltigBis
              ? `Startpasswort${gueltigText(person.startpasswortGueltigBis)}`
              : "Passwortwechsel offen",
          "warn",
          "uhr",
        ),
    person.deaktiviert && chip("Deaktiviert", "fehler"),
  ].filter(Boolean);
  if (liste.length === 0) liste.push(chip("Aktiv", "ok"));
  return el("ul", { class: "chips" }, liste);
}

// Aktion im Seitenblatt: Titel und Erklärung links, Knopf rechts
function kontoAktion(titel, text, knopfKnoten) {
  return el(
    "div",
    { class: "zeile" },
    el(
      "div",
      { class: "personen-aktion" },
      el("p", { class: "name" }, titel),
      el("p", { class: "klein leise" }, text),
    ),
    knopfKnoten,
  );
}

function bearbeiten(person, daten, ctx, neu, tr) {
  const eigenes = person.id === ctx.ich.id;
  const formId = neueId("person-form");
  const name = feld({
    label: "Name",
    hilfe: "Vorname und Nachname in einem Feld.",
    wert: person.name,
    maxlength: 201,
    required: true,
  });
  const telefon = feld({
    label: "Telefon (optional)",
    typ: "tel",
    hilfe:
      "Nur für Stufenleitungen. Eltern, Leitende und Stufenleitung der Stufe sehen die Nummer bei den Kontakten. Leer lassen, um sie zu entfernen.",
    wert: person.telefon ?? "",
    maxlength: 30,
    autocomplete: "off",
  });
  const admin = ankreuzen({
    label: "Admin-Rechte",
    gewaehlt: person.admin,
  });
  const rollen = rollenFelder(daten.stufen, person.rollen);
  const kinder = kinderFelder(daten.kinder, daten.stufen, person.elternteilVon);
  const fehler = el("p", {
    class: "hinweis hinweis--fehler",
    role: "alert",
    hidden: true,
    tabindex: "-1",
  });
  const schliesse = () => blatt.close();
  const formular = el(
    "form",
    { id: formId, novalidate: true },
    el(
      "div",
      { class: "abschnitt" },
      el("h3", {}, "Angaben"),
      name.wurzel,
      telefon.wurzel,
      el(
        "div",
        { class: "feld" },
        el("span", { class: "legende" }, "Benutzername"),
        el("p", { class: "personen-benutzername" }, person.benutzername ?? "–"),
        el("p", { class: "hilfe" }, "Der Benutzername bleibt fest."),
      ),
    ),
    el(
      "div",
      { class: "abschnitt" },
      el("h3", {}, "Rechte"),
      admin.wurzel,
      el(
        "p",
        { class: "hilfe" },
        "Admins brauchen einen zweiten Faktor, bevor sie die Verwaltung öffnen können.",
      ),
    ),
    rollen.wurzel,
    kinder.wurzel,
    fehler,
  );
  const abbrechen = knopf("Abbrechen", { onclick: schliesse });
  const speichern = el(
    "button",
    { type: "submit", form: formId, class: "knopf knopf--haupt" },
    "Speichern",
  );
  formular.addEventListener("submit", async (ereignis) => {
    ereignis.preventDefault();
    fehler.hidden = true;
    abbrechen.disabled = speichern.disabled = true;
    try {
      await anfrage("PATCH", `/api/v1/admin/personen/${person.id}`, {
        name: name.eingabe.value.trim(),
        telefon: telefon.eingabe.value,
        admin: admin.eingabe.checked,
        rollen: rollen.wert(),
        elternteilVon: kinder.wert(),
      });
      zustand.fokus = person.id;
      blatt.close();
      neu();
      ctx.melde("Gespeichert.");
    } catch (f) {
      fehler.textContent = fehlertext(f);
      fehler.hidden = false;
      fehler.focus();
    } finally {
      abbrechen.disabled = speichern.disabled = false;
    }
  });
  const konto = el(
    "div",
    { class: "abschnitt" },
    el("h3", {}, "Konto"),
    eigenes
      ? el(
          "p",
          { class: "hilfe" },
          "Für das eigene Konto gibt es diese Aktionen nicht.",
        )
      : [
          kontoAktion(
            "Neues Startpasswort",
            "Meldet die Person überall ab. Das Passwort gilt 7 Tage und bleibt in der Liste sichtbar, bis die Person es ersetzt hat.",
            knopf("Startpasswort erzeugen", {
              klein: true,
              symbol: "schluessel",
              onclick: () => neuesStartpasswort(person, ctx, neu, schliesse),
            }),
          ),
          person.zweiterFaktor &&
            kontoAktion(
              "Zweiter Faktor",
              "Die Person muss ihn danach neu einrichten.",
              knopf("Zweiten Faktor zurücksetzen", {
                klein: true,
                art: "gefahr",
                symbol: "schild",
                onclick: () => faktorZuruecksetzen(person, ctx, neu, schliesse),
              }),
            ),
          person.deaktiviert
            ? kontoAktion(
                "Person aktivieren",
                "Sie kann sich wieder anmelden.",
                knopf("Aktivieren", {
                  klein: true,
                  symbol: "haken",
                  onclick: () => umschalten(person, ctx, neu, schliesse),
                }),
              )
            : kontoAktion(
                "Person deaktivieren",
                "Sie kann sich nicht mehr anmelden und wird überall abgemeldet.",
                knopf("Deaktivieren", {
                  klein: true,
                  art: "gefahr",
                  symbol: "sperre",
                  onclick: () => umschalten(person, ctx, neu, schliesse),
                }),
              ),
        ],
  );
  tr.classList.add("gewaehlt");
  const blatt = seitenblatt({
    titel: person.name,
    untertitel: "Person bearbeiten",
    inhalt: [
      el("div", { class: "blatt-status" }, statusChips(person)),
      formular,
      konto,
    ],
    fusszeile: [abbrechen, speichern],
    schliessen: () => tr.classList.remove("gewaehlt"),
  });
}

function zeile(person, daten, ctx, neu) {
  const stufenname = new Map(daten.stufen.map((s) => [s.id, s.name]));
  const kindname = new Map(
    daten.kinder.map((k) => [k.id, `${k.vorname} ${k.nachname}`]),
  );
  const eigenes = person.id === ctx.ich.id;
  const rollenChips = person.rollen.map((r) =>
    chip(
      `${stufenname.get(r.stufeId) ?? "Stufe"} · ${ROLLENNAME[r.typ]}`,
      "stufe",
      false,
    ),
  );
  const kinder = person.elternteilVon.map((id) => kindname.get(id) ?? "Kind");
  const bearbeitenKnopf = knopf("Bearbeiten", {
    klein: true,
    kontext: person.name,
    symbol: "bearbeiten",
    onclick: () => bearbeiten(person, daten, ctx, neu, tr),
  });
  const tr = el(
    "tr",
    { class: person.deaktiviert ? "inaktiv" : undefined },
    el(
      "th",
      { scope: "row" },
      el(
        "div",
        { class: "wer" },
        avatar(person.name, { hell: !eigenes, bildUrl: person.bildUrl }),
        el(
          "div",
          {},
          el("span", { class: "name" }, person.name, eigenes && " (du)"),
          el("span", { class: "leise" }, person.benutzername ?? "–"),
        ),
      ),
    ),
    el(
      "td",
      {},
      rollenChips.length ? el("ul", { class: "chips" }, rollenChips) : leer(),
    ),
    el("td", {}, kinder.length ? kinder.join(", ") : leer()),
    el("td", {}, statusChips(person)),
    aktionenZelle(
      !eigenes &&
        startpasswortAbgelaufen(person) &&
        knopf("Erneuern", {
          klein: true,
          kontext: `Startpasswort für ${person.name}`,
          symbol: "schluessel",
          onclick: () => {
            zustand.fokus = person.id;
            neuesStartpasswort(person, ctx, neu, () => {});
          },
        }),
      bearbeitenKnopf,
    ),
  );
  return { tr, knopf: bearbeitenKnopf, person };
}

function zeichne(bereich, ctx, daten, neu) {
  const eintraege = daten.personen.map((p) => zeile(p, daten, ctx, neu));
  const { wurzel } = tabelle({
    beschriftung: "Personen",
    spalten: ["Person", "Rollen", "Elternteil von", "Status", "Aktionen"],
    zeilen: eintraege.map((e) => e.tr),
  });
  const FILTER = {
    alle: () => true,
    admins: (p) => p.admin,
    offen: (p) => p.mussPasswortAendern,
    deaktiviert: (p) => p.deaktiviert,
  };
  const anzahl = (wert) => daten.personen.filter((p) => FILTER[wert](p)).length;
  const zaehler = el("p", { class: "meta zaehler", role: "status" });
  const suchId = neueId("suche");
  const aktualisiere = () => {
    const frage = zustand.frage.trim().toLowerCase();
    treffer = eintraege.filter(
      (e) =>
        FILTER[zustand.filter](e.person) &&
        `${e.person.name} ${e.person.benutzername ?? ""}`
          .toLowerCase()
          .includes(frage),
    );
    const [von, bis] = seiten.fenster(treffer.length);
    const sichtbar = new Set(treffer.slice(von, bis));
    for (const e of eintraege) e.tr.hidden = !sichtbar.has(e);
    zaehler.textContent = `${treffer.length} von ${daten.personen.length} Personen`;
  };
  let treffer = [];
  const seiten = seitenwahl({ beiWechsel: aktualisiere });
  const vonVorn = () => {
    seiten.anfang();
    aktualisiere();
  };
  const suche = el("input", {
    class: "eingabe",
    id: suchId,
    type: "search",
    placeholder: "Name oder Benutzername",
    autocomplete: "off",
    oninput: () => {
      zustand.frage = suche.value;
      vonVorn();
    },
  });
  suche.value = zustand.frage;
  const filter = filterGruppe({
    beschriftung: "Filter",
    wert: zustand.filter,
    eintraege: [
      { text: "Alle", wert: "alle" },
      { text: "Admins", wert: "admins" },
      { text: "Startpasswort offen", wert: "offen" },
      { text: "Deaktiviert", wert: "deaktiviert" },
    ].map((e) => ({ ...e, n: anzahl(e.wert) })),
    beiAenderung: (wert) => {
      zustand.filter = wert;
      vonVorn();
    },
  });
  aktualisiere();
  ctx.kopfAktion(
    knopf("Person anlegen", {
      art: "haupt",
      symbol: "plus",
      onclick: () => anlegen(daten, ctx, neu),
    }),
  );
  bereich.append(
    el(
      "div",
      { class: "werkzeuge" },
      el(
        "div",
        { class: "suche" },
        el("label", { class: "nur-leser", for: suchId }, "Personen suchen"),
        icon("lupe"),
        suche,
      ),
      filter.wurzel,
    ),
    zaehler,
    wurzel,
    seiten.wurzel,
  );
  // Nach Speichern oder Kontoaktion zurück zur Zeile, wenn kein Dialog den Fokus hält
  if (zustand.fokus) {
    const ziel = eintraege.find((e) => e.person.id === zustand.fokus);
    zustand.fokus = null;
    // Steht die Person auf einer späteren Seite, blättert die Liste zu ihr, damit der Fokus eine sichtbare Zeile trifft
    if (ziel && ziel.tr.hidden) {
      seiten.zu(treffer.indexOf(ziel));
      aktualisiere();
    }
    if (!document.querySelector("dialog[open]")) ziel?.knopf.focus();
  }
}
