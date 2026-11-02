import { ApiFehler, anfrage, beiSitzungsende, fehlertext } from "./api.js";
import { avatar, codefeld, el, feld, icon, knopf, kopf, leere } from "./dom.js";
import * as konten from "./konten.js";
import * as system from "./system.js";
import * as uebersicht from "./uebersicht.js";

// [Schlüssel im Hash, Name, Modul, Icon, Untertitel im Seitenkopf]
const BEREICHE = [
  [
    "uebersicht",
    "Übersicht",
    uebersicht,
    "uebersicht",
    "Zustand der API auf einen Blick.",
  ],
  [
    "konten",
    "Konto löschen",
    konten,
    "papierkorb",
    "Ein Konto endgültig löschen, nach Rückfrage.",
  ],
  [
    "system",
    "System",
    system,
    "system",
    "Zustand von API, Datenbank und Anfragen.",
  ],
];

const app = document.getElementById("app");
let ich = null;

function zeichne(...knoten) {
  for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
  leere(app);
  app.append(...knoten);
}

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

// Chip über dem Titel; Zustand nie nur über Farbe, daher immer mit Symbol und Text
// def: [Text, Icon, Art]; ohne Art bleibt der Chip neutral
function zeichen([text, symbol, art]) {
  return el(
    "span",
    { class: art ? `chip chip--${art} chip--allein` : "chip chip--allein" },
    icon(symbol),
    text,
  );
}

const SITZUNG_ENDE = ["401 · Sitzung abgelaufen", "uhr"];
const ZU_VIELE = ["429 · Zu viele Versuche", "uhr", "warn"];

// Texte und Symbol der Fehler- und Zustandsseiten nach dem Status; ohne Status (kein ApiFehler) gilt der allgemeine Fehler
function zustandsDaten(f) {
  const status = f instanceof ApiFehler ? f.status : undefined;
  const text = fehlertext(f);
  if (f?.offline) {
    return {
      ueber: "Keine Verbindung",
      titel: "Keine Verbindung.",
      text,
      symbol: "schliessen",
      art: "warn",
    };
  }
  if (status === 502 || status === 503) {
    return {
      ueber: `Fehler ${status}`,
      titel: "Die Verwaltung ist gerade nicht erreichbar.",
      text,
      symbol: "uhr",
      art: "warn",
    };
  }
  if (status === 403) {
    return {
      ueber: "Fehler 403",
      titel: "Kein Zugriff.",
      text,
      symbol: "sperre",
      art: "fehler",
    };
  }
  if (status === 404) {
    return {
      ueber: "Fehler 404",
      titel: "Nicht gefunden.",
      text: "Vielleicht wurde der Eintrag inzwischen geändert oder gelöscht.",
      symbol: "lupe",
    };
  }
  if (status === 429) {
    return {
      ueber: "Fehler 429",
      titel: "Zu viele Versuche.",
      text,
      symbol: "uhr",
      art: "warn",
    };
  }
  return {
    ueber: status ? `Fehler ${status}` : "Fehler",
    titel: "Da ist etwas schiefgelaufen.",
    text,
    symbol: "warnung",
    art: "fehler",
    hilfe:
      "Passiert es immer wieder, sag es mit Uhrzeit und Bereich der Person, die den Server betreut.",
  };
}

// Zustandskarte im Inhaltsbereich; der Fokus liegt danach auf dem Titel, die Meldung wird als Alert angesagt
// ebene: "h2" im Bereich unter dem Seitenkopf, "h1" wenn kein Seitenkopf davorsteht
function zustandsKarte(d, aktionen, ebene = "h2") {
  const titel = el(ebene, { tabindex: "-1" }, d.titel);
  const wurzel = el(
    "section",
    { class: "zustand", role: "alert" },
    el(
      "span",
      {
        class: d.art
          ? `zustand-kreis zustand-kreis--${d.art}`
          : "zustand-kreis",
      },
      icon(d.symbol),
    ),
    el(
      "div",
      { class: "zustand-text" },
      el("p", { class: "ueber" }, d.ueber),
      titel,
      el("p", { class: "leise" }, d.text),
    ),
    d.hilfe && el("p", { class: "hilfe" }, d.hilfe),
    el("div", { class: "aktionen" }, aktionen),
  );
  return { wurzel, titel };
}

// Karte in der Mitte: Überzeile, Titel und Text zuerst; der Fokus liegt danach auf dem Hinweis oder dem Titel
// kopfzeichen: Chip oder Symbol über der Überzeile
function anmeldeSeite({
  ueber = "FireResponse · Verwaltung",
  titel,
  text,
  hinweis,
  kopfzeichen,
  inhalt = [],
}) {
  const ueberschrift = el("h1", { tabindex: "-1" }, titel);
  const meldung =
    hinweis &&
    el("p", { class: "hinweis", role: "status", tabindex: "-1" }, hinweis);
  zeichne(
    el(
      "div",
      { class: "mitte" },
      el(
        "main",
        { class: "anmeldung karte", id: "inhalt", tabindex: "-1" },
        el(
          "div",
          { class: "anmeldung-kopf" },
          kopfzeichen,
          el("p", { class: "ueber" }, ueber),
          ueberschrift,
          el("p", { class: "leise" }, text),
        ),
        meldung,
        ...inhalt,
      ),
    ),
  );
  (meldung || ueberschrift).focus();
}

// kopfzeichen: Chip-Definition für zeichen(), z. B. SITZUNG_ENDE
function zeigeLogin(hinweis, kopfzeichen) {
  ich = null;
  // Der Chip für «zu viele Versuche» steht von Anfang an im Kopf und erscheint erst bei einer 429
  const zuViele = zeichen(ZU_VIELE);
  zuViele.hidden = true;
  const name = feld({
    label: "Benutzername",
    autocomplete: "username",
    autocapitalize: "none",
    spellcheck: "false",
    required: true,
  });
  const passwort = feld({
    label: "Passwort",
    typ: "password",
    autocomplete: "current-password",
    required: true,
  });
  const sichtbar = el("input", { id: "passwort-zeigen", type: "checkbox" });
  sichtbar.addEventListener("change", () => {
    passwort.eingabe.type = sichtbar.checked ? "text" : "password";
  });
  const fehler = fehlerfeld();
  const senden = el(
    "button",
    { type: "submit", class: "knopf knopf--haupt knopf--gross" },
    "Anmelden",
  );
  const formular = el(
    "form",
    { class: "formular", novalidate: true },
    name.wurzel,
    passwort.wurzel,
    el(
      "div",
      { class: "wahl" },
      sichtbar,
      el("label", { for: "passwort-zeigen" }, "Passwort anzeigen"),
    ),
    fehler,
    senden,
  );
  formular.addEventListener("submit", async (ereignis) => {
    ereignis.preventDefault();
    fehler.hidden = true;
    zuViele.hidden = true;
    if (!name.eingabe.value.trim() || !passwort.eingabe.value) {
      zeigeFehler(fehler, "Bitte gib Benutzername und Passwort ein.");
      return;
    }
    senden.disabled = true;
    try {
      const antwort = await anfrage("POST", "/api/auth/sign-in/username", {
        username: name.eingabe.value.trim(),
        password: passwort.eingabe.value,
      });
      passwort.eingabe.value = "";
      if (antwort?.twoFactorRedirect) zeigeCode();
      else await pruefeKonto();
    } catch (f) {
      const gebremst = f.status === 429;
      zuViele.hidden = !gebremst;
      fehler.className = gebremst
        ? "hinweis hinweis--warn"
        : "hinweis hinweis--fehler";
      zeigeFehler(fehler, fehlertext(f));
    } finally {
      senden.disabled = false;
    }
  });
  anmeldeSeite({
    titel: "Anmelden",
    text: "Melde dich mit deinem Admin-Konto an.",
    hinweis,
    kopfzeichen: kopfzeichen ? zeichen(kopfzeichen) : zuViele,
    inhalt: [formular],
  });
}

function zeigeCode(ersatz = false) {
  const code = ersatz
    ? feld({
        label: "Ersatzcode",
        hilfe: "Format: xxxxx-xxxxx. Jeder Ersatzcode gilt nur einmal.",
        autocomplete: "off",
        autocapitalize: "none",
        spellcheck: "false",
        required: true,
      })
    : codefeld({
        label: "Code aus der Authenticator-App",
        hilfe: "Sechs Ziffern. Der Code wird nach der letzten Ziffer geprüft.",
        required: true,
      });
  const fehler = fehlerfeld();
  const senden = el(
    "button",
    { type: "submit", class: "knopf knopf--haupt knopf--gross" },
    "Bestätigen",
  );
  const formular = el(
    "form",
    { class: "formular", novalidate: true },
    code.wurzel,
    fehler,
    senden,
    knopf(ersatz ? "Code aus der App verwenden" : "Ersatzcode verwenden", {
      art: "still",
      onclick: () => zeigeCode(!ersatz),
    }),
    knopf("Abbrechen", { art: "still", onclick: () => zeigeLogin() }),
  );
  formular.addEventListener("submit", async (ereignis) => {
    ereignis.preventDefault();
    fehler.hidden = true;
    const wert = code.eingabe.value.trim();
    if (!wert) {
      zeigeFehler(fehler, "Bitte gib den Code ein.");
      return;
    }
    senden.disabled = true;
    try {
      await anfrage(
        "POST",
        ersatz
          ? "/api/auth/two-factor/verify-backup-code"
          : "/api/auth/two-factor/verify-totp",
        { code: wert },
      );
      await pruefeKonto();
    } catch (f) {
      // Ohne gültiges Zwischen-Cookie hilft nur eine neue Anmeldung
      if (
        f.code === "INVALID_TWO_FACTOR_COOKIE" ||
        f.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE"
      ) {
        zeigeLogin(fehlertext(f));
      } else {
        code.eingabe.value = "";
        code.eingabe.dispatchEvent(new window.Event("input"));
        code.eingabe.setAttribute("aria-invalid", "true");
        zeigeFehler(fehler, fehlertext(f));
      }
    } finally {
      senden.disabled = false;
    }
  });
  anmeldeSeite({
    ueber: "Schritt 2 von 2",
    titel: "Zweiter Faktor",
    text: ersatz
      ? "Gib einen deiner Ersatzcodes ein."
      : "Gib den Code aus deiner Authenticator-App ein.",
    kopfzeichen: el("span", { class: "kreis" }, icon("schild")),
    inhalt: [formular],
  });
  code.eingabe.focus();
}

const SPERRE_2FA = ["Zweiter Faktor fehlt", "schild", "warn"];

// grund: [Text des Chips, Icon, Art]; ohne Angabe gilt der fehlende zweite Faktor
function zeigeSperre(text, grund = SPERRE_2FA) {
  anmeldeSeite({
    titel: "Verwaltung nicht möglich",
    text,
    kopfzeichen: zeichen(grund),
    inhalt: [knopf("Abmelden", { symbol: "abmelden", onclick: abmelden })],
  });
}

// Beim Start ist «keine Sitzung» der Normalfall; nach einer Anmeldung ist es ein Fehler
async function pruefeKonto(nachAnmeldung = true) {
  const sitzung = await anfrage("GET", "/api/auth/get-session");
  if (!sitzung) {
    zeigeLogin(
      nachAnmeldung
        ? "Die Anmeldung hat keine Sitzung ergeben. Versuche es nochmals."
        : undefined,
    );
    return;
  }
  ich = sitzung.user;
  if (ich.role !== "admin") {
    zeigeSperre("Dieses Konto hat keine Admin-Rechte.", [
      "403 · Keine Admin-Rechte",
      "sperre",
      "fehler",
    ]);
  } else if (ich.mussPasswortAendern) {
    zeigeSperre(
      "Du musst zuerst dein Startpasswort ändern. Das geht in der App. Melde dich danach hier neu an.",
      ["Startpasswort offen", "schluessel", "warn"],
    );
  } else if (!ich.twoFactorEnabled) {
    zeigeSperre(
      "Für die Verwaltung braucht es zuerst einen zweiten Faktor. Richte ihn ein und melde dich danach neu an.",
    );
  } else {
    zeigeVerwaltung();
  }
}

async function abmelden() {
  try {
    await anfrage("POST", "/api/auth/sign-out", {});
  } catch (f) {
    if (document.getElementById("rueckmeldung")) melde(fehlertext(f), "fehler");
    else zeigeLogin(fehlertext(f));
    return;
  }
  zeigeLogin("Du bist abgemeldet.");
}

// Rückmeldungen stehen in einer Live-Region: Leeren und kurz danach setzen, damit auch ein gleicher Text wieder angesagt wird
function melde(text, art = "ok") {
  const bereich = document.getElementById("rueckmeldung");
  if (!bereich) return;
  bereich.textContent = "";
  bereich.className = text
    ? `rueckmeldung hinweis hinweis--${art}`
    : "rueckmeldung";
  bereich.setAttribute("role", art === "fehler" ? "alert" : "status");
  setTimeout(() => {
    bereich.textContent = text;
  }, 50);
}

function zurUebersicht(klasse = "") {
  return el(
    "a",
    { class: `knopf ${klasse}`.trim(), href: "#uebersicht" },
    icon("uebersicht"),
    "Zur Übersicht",
  );
}

// Lädt Daten in den Bereich und zeichnet sie; die zweite Funktion lädt dieselbe Ansicht nochmals, ohne den Bereich vorher zu leeren
function erstelleLader(bereich) {
  async function lade(laden, zeichnen) {
    if (!bereich.firstChild) {
      bereich.append(
        el("p", { class: "meta", role: "status" }, "Wird geladen …"),
      );
    }
    let daten;
    try {
      daten = await laden();
    } catch (f) {
      if (!bereich.isConnected) return;
      leere(bereich);
      const karte = zustandsKarte(zustandsDaten(f), [
        knopf("Nochmals versuchen", {
          art: "haupt",
          symbol: "aktualisieren",
          onclick: () => lade(laden, zeichnen),
        }),
        f.status === 404 && zurUebersicht(),
      ]);
      bereich.append(karte.wurzel);
      karte.titel.focus();
      return;
    }
    // Zwischen Anfrage und Antwort kann man den Bereich gewechselt haben
    if (!bereich.isConnected) return;
    leere(bereich);
    zeichnen(daten, () => lade(laden, zeichnen));
  }
  return lade;
}

function zeigeVerwaltung() {
  const bereiche = el(
    "nav",
    { class: "bereiche", "aria-label": "Bereiche" },
    BEREICHE.map(([schluessel, name, , symbol]) =>
      el(
        "a",
        { class: "punkt", href: `#${schluessel}`, "data-bereich": schluessel },
        icon(symbol),
        el("span", {}, name),
      ),
    ),
  );
  const rueckmeldung = el("div", {
    id: "rueckmeldung",
    class: "rueckmeldung",
    role: "status",
  });
  const dock = el(
    "aside",
    { class: "dock" },
    el(
      "div",
      { class: "marke" },
      el("p", { class: "ueber" }, "FireResponse"),
      el("strong", {}, "Verwaltung"),
    ),
    bereiche,
    el(
      "div",
      { class: "konto" },
      el(
        "div",
        { class: "konto-zeile" },
        avatar(ich.name),
        el(
          "div",
          { class: "konto-text" },
          el("p", { class: "kontoname" }, ich.name),
          el(
            "p",
            { class: "mini leise" },
            ich.twoFactorEnabled ? "Admin · zweiter Faktor aktiv" : "Admin",
          ),
        ),
      ),
      knopf("Abmelden", { klein: true, symbol: "abmelden", onclick: abmelden }),
    ),
  );
  zeichne(
    el(
      "div",
      { class: "app" },
      dock,
      el(
        "main",
        { class: "inhalt", id: "inhalt", tabindex: "-1" },
        el(
          "div",
          { class: "rahmen" },
          el("div", { id: "seitenkopf" }),
          rueckmeldung,
          el("div", { id: "bereich" }),
        ),
      ),
    ),
  );
  navigiere();
}

function markiereBereich(schluessel) {
  for (const link of document.querySelectorAll("nav.bereiche a")) {
    if (link.dataset.bereich === schluessel)
      link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function zeigeNichtGefunden() {
  markiereBereich();
  document
    .getElementById("seitenkopf")
    .replaceWith(el("div", { id: "seitenkopf" }));
  document.title = "Nicht gefunden – Verwaltung – FireResponse";
  melde("");
  const karte = zustandsKarte(
    {
      ueber: "Fehler 404",
      titel: "Diese Seite gibt es nicht.",
      text: "Der Link ist vielleicht alt, oder der Bereich heisst inzwischen anders. Wähle links einen Bereich oder geh zur Übersicht.",
      symbol: "lupe",
    },
    [zurUebersicht("knopf--haupt")],
    "h1",
  );
  document
    .getElementById("bereich")
    .replaceWith(el("div", { id: "bereich" }, karte.wurzel));
  karte.titel.focus();
}

function navigiere() {
  if (!ich || !document.getElementById("bereich")) return;
  // Der Sprunglink «Zum Inhalt» setzt #inhalt: nur den Fokus verschieben, den Bereich nicht neu laden
  if (location.hash === "#inhalt") {
    document.getElementById("inhalt").focus();
    return;
  }
  const gesucht = location.hash.slice(1);
  const treffer = BEREICHE.find(([s]) => s === gesucht);
  // Ohne Hash gilt die Übersicht; ein unbekannter Hash ist ein toter Link
  if (gesucht && !treffer) {
    zeigeNichtGefunden();
    return;
  }
  const [schluessel, name, ansicht, , untertitel] = treffer ?? BEREICHE[0];
  markiereBereich(schluessel);
  const seitenkopf = kopf({ ueber: "Verwaltung", titel: name, untertitel });
  seitenkopf.id = "seitenkopf";
  document.getElementById("seitenkopf").replaceWith(seitenkopf);
  document.title = `${name} – Verwaltung – FireResponse`;
  melde("");
  // Ein neuer Container je Navigation: Späte Antworten des alten landen in einem abgehängten Knoten
  const bereich = el("div", { id: "bereich" });
  document.getElementById("bereich").replaceWith(bereich);
  ansicht.zeige(bereich, {
    ich,
    melde,
    lade: erstelleLader(bereich),
    // Hauptaktion rechts im Seitenkopf, z. B. «Person anlegen»; der Kopf wird mit jeder Navigation neu gebaut
    kopfAktion: (...knoten) =>
      seitenkopf.querySelector(".kopf-aktion").replaceChildren(...knoten),
  });
  seitenkopf.querySelector("h1").focus();
}

window.addEventListener("hashchange", navigiere);
beiSitzungsende(() => {
  if (ich) {
    zeigeLogin(
      "Die Sitzung ist abgelaufen. Bitte melde dich neu an.",
      SITZUNG_ENDE,
    );
  }
});

// Ist die API beim Start nicht erreichbar, hilft keine Anmeldung: eigene Seite mit «Nochmals versuchen»
function zeigeStartFehler(f) {
  ich = null;
  const d = zustandsDaten(f);
  anmeldeSeite({
    titel: d.titel,
    text: d.text,
    kopfzeichen: zeichen([d.ueber, d.symbol, d.art]),
    inhalt: [
      d.hilfe && el("p", { class: "hilfe" }, d.hilfe),
      knopf("Nochmals versuchen", {
        art: "haupt",
        symbol: "aktualisieren",
        onclick: () => pruefeKonto(false).catch(zeigeStartFehler),
      }),
    ],
  });
}

pruefeKonto(false).catch(zeigeStartFehler);
