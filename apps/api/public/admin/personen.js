import { anfrage, fehlertext } from "./api.js";
import {
  aktionenZelle,
  avatar,
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
import { darfStellvertretungen, ROLLENNAME } from "./kontext.js";
import {
  aufgabenHinweis,
  BENUTZERNAME_HILFE,
  kontoMenueEintraege,
  mehrzahl,
  zustandsChips,
} from "./konten.js";
import { raengeAuswahl, raengeVomTyp, rangZelle } from "./raenge.js";

// Suche und Filter überleben das Neuladen nach einer Aktion; fokus: Person, deren Zeile danach den Fokus bekommt
const zustand = { frage: "", filter: "alle", fokus: null };

const FILTER = [
  ["alle", "Alle"],
  ["verwaltung", "Kommando und Stellvertretung"],
  ["leitung", "Leitende"],
  ["offen", "Startpasswort offen"],
  ["deaktiviert", "Deaktiviert"],
];

const basis = (einheit) => `/api/v1/admin/einheiten/${einheit.id}`;

export function zeige(bereich, ctx) {
  zustand.frage = "";
  zustand.filter = "alle";
  zustand.fokus = null;
  const einheit = ctx.einheit;
  ctx.lade(
    async () => {
      const [personen, raenge] = await Promise.all([
        anfrage("GET", `${basis(einheit)}/personen`),
        anfrage("GET", `${basis(einheit)}/raenge`),
      ]);
      return { personen: personen.personen, raenge: raenge.raenge };
    },
    (daten, neu) => zeichne(bereich, ctx, einheit, daten, neu),
  );
}

const startpasswortDialog = (name, startpasswort) =>
  geheimnisDialog({
    titel: "Startpasswort",
    beschreibung: `Gib das Startpasswort für «${name}» sicher weiter. Es gilt 7 Tage. Es steht nur in diesem Fenster und ist weg, sobald du es schliesst.`,
    wert: startpasswort,
  });

// Leitende und Stellvertretungen entstehen mit einem neuen Konto; die Rolle ergibt sich aus der Route
function anlegen(art, einheit, ctx, neu) {
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
  const stv = art === "stellvertretung";
  const telefon = stv
    ? feld({
        label: "Telefon (optional)",
        typ: "tel",
        hilfe:
          "Die Stellvertretungen sind Kontakte der Einheit: Eltern und Teilnehmende sehen die Nummer in der App.",
        maxlength: 30,
        autocomplete: "off",
      })
    : null;
  dialogFormular({
    titel: stv ? "Stellvertretung anlegen" : "Leitende Person anlegen",
    beschreibung: stv
      ? "Die neue Stellvertretung kommt ans Ende der Reihenfolge und erhält ein Startpasswort."
      : "Die Person erhält ein Startpasswort. Sie sieht alle Anmeldungen der Einheit.",
    felder: [
      vorname.wurzel,
      nachname.wurzel,
      benutzername.wurzel,
      telefon?.wurzel,
    ],
    ok: "Anlegen",
    senden: () =>
      anfrage(
        "POST",
        `${basis(einheit)}/${stv ? "stellvertretungen" : "leitende"}`,
        {
          vorname: vorname.eingabe.value.trim(),
          nachname: nachname.eingabe.value.trim(),
          benutzername: benutzername.eingabe.value.trim(),
          ...(telefon && telefon.eingabe.value.trim()
            ? { telefon: telefon.eingabe.value.trim() }
            : {}),
        },
      ),
    danach: (antwort) => {
      zustand.fokus = antwort.id;
      neu();
      ctx.melde(`Konto «${antwort.benutzername}» ist angelegt.`);
      startpasswortDialog(
        `${vorname.eingabe.value.trim()} ${nachname.eingabe.value.trim()}`,
        antwort.startpasswort,
      );
    },
  });
}

// Ein Konto, das schon eine Rolle in einer anderen Einheit hat, wird hier zusätzlich Leitung (ein Konto für JF und KF)
function zuweisen(einheit, ctx, neu) {
  const benutzername = feld({
    label: "Benutzername",
    hilfe:
      "Das Konto muss schon eine Rolle haben. Das Kommando findet nur Konten aus den Einheiten, die es selbst verwaltet; sonst weist der Kantonsadmin zu.",
    maxlength: 64,
    autocapitalize: "none",
    autocomplete: "off",
    spellcheck: "false",
    required: true,
  });
  dialogFormular({
    titel: "Bestehende Person hinzufügen",
    beschreibung:
      "Die Person wird Leitung dieser Einheit und behält ihr Konto und ihr Passwort. Zurücksetzen und Deaktivieren macht danach nur noch der Kantonsadmin.",
    felder: [benutzername.wurzel],
    ok: "Hinzufügen",
    senden: () =>
      anfrage("POST", `${basis(einheit)}/leitende/bestehend`, {
        benutzername: benutzername.eingabe.value.trim(),
      }),
    danach: () => {
      neu();
      ctx.melde("Die Person ist als Leitung hinzugefügt.");
    },
  });
}

// Seitenblatt: Name und Telefon (wenn die API es erlaubt), Rang und die Aktionen am Konto
function bearbeiten(person, einheit, daten, ctx, neu) {
  const kontakt =
    person.rolle === "kommandant" || person.rolle === "stellvertretung";
  const name = person.aktionen.bearbeiten
    ? feld({
        label: "Name",
        wert: person.name,
        maxlength: 201,
        required: true,
      })
    : null;
  const telefon =
    person.aktionen.bearbeiten && kontakt
      ? feld({
          label: "Telefon",
          typ: "tel",
          wert: person.telefon ?? "",
          maxlength: 30,
          autocomplete: "off",
          hilfe:
            "Eltern und Teilnehmende sehen die Nummer in der App. Leer lassen, um sie zu entfernen.",
        })
      : null;
  const rang = raengeAuswahl(
    raengeVomTyp(daten.raenge, "miliz"),
    person.rang?.id ?? "",
    "Rang",
  );
  const blatt = seitenblatt({
    titel: person.name,
    untertitel: `${ROLLENNAME[person.rolle]} · ${person.benutzername}`,
    inhalt: [
      el(
        "form",
        {
          class: "formular",
          id: "person-formular",
          novalidate: true,
          onsubmit: (e) => e.preventDefault(),
        },
        el("h3", {}, "Angaben"),
        name?.wurzel,
        telefon?.wurzel,
        rang.wurzel,
      ),
      el("h3", {}, "Zustand"),
      el("ul", { class: "chips" }, zustandsChips(person)),
    ],
    fusszeile: [
      knopf("Abbrechen", { onclick: () => blatt.close() }),
      el(
        "button",
        {
          type: "submit",
          form: "person-formular",
          class: "knopf knopf--haupt",
        },
        "Speichern",
      ),
    ],
  });
  const formular = blatt.querySelector("form");
  const fehler = el("p", {
    class: "hinweis hinweis--fehler",
    role: "alert",
    hidden: true,
    tabindex: "-1",
  });
  formular.append(fehler);
  formular.addEventListener("submit", async () => {
    fehler.hidden = true;
    const body = {};
    if (name && name.eingabe.value.trim() !== person.name) {
      body.name = name.eingabe.value.trim();
    }
    if (telefon && telefon.eingabe.value.trim() !== (person.telefon ?? "")) {
      body.telefon = telefon.eingabe.value.trim();
    }
    if (rang.eingabe.value !== (person.rang?.id ?? "")) {
      body.rangId = rang.eingabe.value || null;
    }
    if (Object.keys(body).length === 0) {
      blatt.close();
      return;
    }
    try {
      await anfrage("PATCH", `${basis(einheit)}/personen/${person.id}`, body);
    } catch (f) {
      fehler.textContent = fehlertext(f);
      fehler.hidden = false;
      fehler.focus();
      return;
    }
    zustand.fokus = person.id;
    blatt.close();
    neu();
    ctx.melde("Gespeichert.");
  });
}

function leitungEntfernen(person, einheit, ctx, neu) {
  bestaetigen({
    titel: "Leitung entfernen",
    beschreibung: `«${person.name}» ist danach nicht mehr Leitung dieser Einheit. Das Konto bleibt bestehen.`,
    ok: "Entfernen",
    aktion: () => anfrage("DELETE", `${basis(einheit)}/leitende/${person.id}`),
    danach: () => {
      neu();
      ctx.melde(`«${person.name}» ist nicht mehr Leitung.`);
    },
  });
}

function stellvertretungEntfernen(person, einheit, ctx, neu) {
  bestaetigen({
    titel: "Stellvertretung entfernen",
    beschreibung: `«${person.name}» ist danach nicht mehr Stellvertretung. Die übrigen rücken nach. Das Konto bleibt bestehen.`,
    ok: "Entfernen",
    aktion: () =>
      anfrage("DELETE", `${basis(einheit)}/stellvertretungen/${person.id}`),
    danach: () => {
      neu();
      ctx.melde(`«${person.name}» ist nicht mehr Stellvertretung.`);
    },
  });
}

// Befördert eine Leitung ans Ende der Stellvertretungen oder stuft eine Stellvertretung zur Leitung zurück; nur das Kommando
function rolleAendern(person, nach, einheit, ctx, neu) {
  const stv = nach === "stellvertretung";
  bestaetigen({
    titel: stv ? "Zur Stellvertretung befördern" : "Zur Leitung zurückstufen",
    beschreibung: stv
      ? `«${person.name}» wird Stellvertretung und kommt ans Ende der Reihenfolge. Konto und Rang bleiben. Sie darf danach die Einheit verwalten und braucht dafür einen zweiten Faktor. Eltern und Teilnehmende sehen die Nummer, falls eine hinterlegt ist.`
      : `«${person.name}» wird Leitung und verlässt die Reihenfolge der Stellvertretungen. Konto und Rang bleiben. Die Nummer ist danach nicht mehr in der App zu sehen.`,
    ok: stv ? "Befördern" : "Zurückstufen",
    aktion: () =>
      anfrage("PUT", `${basis(einheit)}/personen/${person.id}/rolle`, {
        rolle: nach,
      }),
    danach: () => {
      zustand.fokus = person.id;
      neu();
      ctx.melde(
        `«${person.name}» ist jetzt ${stv ? "Stellvertretung" : "Leitung"}.`,
      );
    },
  });
}

// Die Reihenfolge, in der die Kontaktliste der App die Stellvertretungen nennt; nur das Kommando ordnet
function reihenfolgeKarte(stellvertretungen, einheit, ctx, neu) {
  const darf = darfStellvertretungen(einheit);
  const verschiebe = async (person, position) => {
    try {
      await anfrage("PUT", `${basis(einheit)}/stellvertretungen/${person.id}`, {
        reihenfolge: position,
      });
    } catch {
      ctx.melde("Die Reihenfolge lässt sich nicht ändern.", "fehler");
      return;
    }
    zustand.fokus = `${person.id}:${position > person.position ? "runter" : "hoch"}`;
    neu();
    ctx.melde(`«${person.name}» steht jetzt an Position ${position}.`);
  };
  const titelId = neueId("stv");
  return el(
    "section",
    { class: "panel", "aria-labelledby": titelId },
    el("h2", { id: titelId }, "Reihenfolge der Stellvertretungen"),
    el(
      "p",
      { class: "hilfe" },
      "Fällt das Kommando aus, ruft die App zuerst die erste Stellvertretung an.",
    ),
    el(
      "ol",
      { class: "sl-reihenfolge" },
      stellvertretungen.map((p, i) => {
        const person = { ...p, position: i + 1 };
        return el(
          "li",
          {},
          el("span", { class: "reihenfolge-nr" }, `${i + 1}.`),
          el("span", { class: "name" }, p.name),
          darf &&
            el(
              "span",
              { class: "aktionen" },
              knopf("", {
                art: "rund",
                symbol: "hoch",
                "aria-label": `${p.name} nach oben`,
                disabled: i === 0,
                "data-fokus": `${p.id}:hoch`,
                onclick: () => verschiebe(person, i),
              }),
              knopf("", {
                art: "rund",
                symbol: "runter",
                "aria-label": `${p.name} nach unten`,
                disabled: i === stellvertretungen.length - 1,
                "data-fokus": `${p.id}:runter`,
                onclick: () => verschiebe(person, i + 2),
              }),
            ),
        );
      }),
    ),
  );
}

function zeichne(bereich, ctx, einheit, daten, neu) {
  const kopfKnoepfe = [
    darfStellvertretungen(einheit) &&
      knopf("Stellvertretung anlegen", {
        symbol: "plus",
        onclick: () => anlegen("stellvertretung", einheit, ctx, neu),
      }),
    knopf("Bestehende Person hinzufügen", {
      symbol: "plus",
      onclick: () => zuweisen(einheit, ctx, neu),
    }),
    knopf("Leitende Person anlegen", {
      art: "haupt",
      symbol: "plus",
      onclick: () => anlegen("leitung", einheit, ctx, neu),
    }),
  ];
  ctx.kopfAktion(...kopfKnoepfe);
  const personen = daten.personen;
  const offene = personen.filter(
    (p) => p.startpasswort && !p.startpasswort.abgelaufen,
  ).length;
  const abgelaufen = personen.filter((p) => p.startpasswort?.abgelaufen).length;
  const ohneFaktor = personen.filter(
    (p) =>
      (p.rolle === "kommandant" || p.rolle === "stellvertretung") &&
      !p.zweiterFaktor,
  ).length;
  const hinweis = aufgabenHinweis([
    offene > 0 &&
      `${mehrzahl(offene, "Konto hat", "Konten haben")} noch ein offenes Startpasswort.`,
    abgelaufen > 0 &&
      `${mehrzahl(abgelaufen, "Startpasswort ist", "Startpasswörter sind")} abgelaufen: Erzeuge ein neues, sonst kommt die Person nicht hinein.`,
    ohneFaktor > 0 &&
      `${mehrzahl(ohneFaktor, "Person der Verwaltung hat", "Personen der Verwaltung haben")} noch keinen zweiten Faktor.`,
  ]);
  const stellvertretungen = personen
    .filter((p) => p.rolle === "stellvertretung")
    .sort((a, b) => a.reihenfolge - b.reihenfolge);

  const liste = el("div", {});
  const zaehler = el("p", { class: "klein leise", role: "status" });
  const suchId = neueId("suche");
  const suche = el("input", {
    id: suchId,
    class: "eingabe",
    type: "search",
    placeholder: "Name oder Benutzername",
    autocomplete: "off",
    value: zustand.frage,
  });
  const seiten = seitenwahl({ beiWechsel: zeichneListe });
  const filter = filterGruppe({
    beschriftung: "Filter",
    eintraege: FILTER.map(([wert, text]) => ({
      wert,
      text,
      n: personen.filter((p) => passt(p, wert)).length,
    })),
    wert: zustand.filter,
    beiAenderung: (wert) => {
      zustand.filter = wert;
      seiten.anfang();
      zeichneListe();
    },
  });

  function passt(p, wert) {
    if (wert === "verwaltung") {
      return p.rolle === "kommandant" || p.rolle === "stellvertretung";
    }
    if (wert === "leitung") return p.rolle === "leitung";
    if (wert === "offen") return p.startpasswort !== null;
    if (wert === "deaktiviert") return p.deaktiviert;
    return true;
  }

  function zeichneListe() {
    const frage = zustand.frage.trim().toLowerCase();
    const treffer = personen.filter(
      (p) =>
        passt(p, zustand.filter) &&
        `${p.name} ${p.benutzername}`.toLowerCase().includes(frage),
    );
    const [von, bis] = seiten.fenster(treffer.length);
    zaehler.textContent =
      treffer.length === personen.length
        ? mehrzahl(personen.length, "Person", "Personen")
        : `${treffer.length} von ${personen.length} Personen`;
    if (treffer.length === 0) {
      liste.replaceChildren(
        el(
          "p",
          { class: "leer" },
          personen.length === 0
            ? "Es gibt noch keine Personen in dieser Einheit."
            : "Keine Person passt zu Suche und Filter.",
        ),
      );
      return;
    }
    const { wurzel } = tabelle({
      beschriftung: "Personen der Einheit",
      spalten: ["Person", "Rolle", "Rang", "Zustand", "Aktionen"],
      zeilen: treffer.slice(von, bis).map((p) => {
        const eintraege = [
          ...kontoMenueEintraege(p, einheit, ctx, neu),
          p.rolle === "leitung" &&
            darfStellvertretungen(einheit) && {
              text: "Zur Stellvertretung befördern",
              onclick: () =>
                rolleAendern(p, "stellvertretung", einheit, ctx, neu),
            },
          p.rolle === "stellvertretung" &&
            darfStellvertretungen(einheit) && {
              text: "Zur Leitung zurückstufen",
              onclick: () => rolleAendern(p, "leitung", einheit, ctx, neu),
            },
          p.rolle === "leitung" && {
            text: "Als Leitung entfernen",
            gefaehrlich: true,
            onclick: () => leitungEntfernen(p, einheit, ctx, neu),
          },
          p.rolle === "stellvertretung" &&
            darfStellvertretungen(einheit) && {
              text: "Als Stellvertretung entfernen",
              gefaehrlich: true,
              onclick: () => stellvertretungEntfernen(p, einheit, ctx, neu),
            },
        ];
        return el(
          "tr",
          {
            class: p.deaktiviert ? "inaktiv" : undefined,
            "data-fokus": p.id,
          },
          el(
            "th",
            { scope: "row" },
            el(
              "div",
              { class: "wer" },
              avatar(p.name, {
                hell: !p.eigenes,
                bildUrl: p.hatBild
                  ? `/api/v1/admin/personen/${p.id}/bild`
                  : null,
              }),
              el(
                "div",
                {},
                el("span", { class: "name" }, p.name),
                el("span", { class: "mini leise" }, p.benutzername),
              ),
            ),
          ),
          el(
            "td",
            {},
            el(
              "ul",
              { class: "chips" },
              chip(
                p.rolle === "stellvertretung"
                  ? `Stellvertretung ${stellvertretungen.findIndex((s) => s.id === p.id) + 1}`
                  : ROLLENNAME[p.rolle],
                p.rolle === "kommandant" ? "stufe" : undefined,
              ),
            ),
          ),
          el(
            "td",
            {},
            p.rang
              ? rangZelle(
                  daten.raenge.find((r) => r.id === p.rang.id) ?? p.rang,
                )
              : el("span", { class: "leise" }, "–"),
          ),
          el(
            "td",
            {},
            el(
              "ul",
              { class: "chips" },
              zustandsChips(p, {
                verwaltung:
                  p.rolle === "kommandant" || p.rolle === "stellvertretung",
              }),
            ),
          ),
          aktionenZelle(
            knopf("Bearbeiten", {
              klein: true,
              symbol: "bearbeiten",
              kontext: p.name,
              onclick: () => bearbeiten(p, einheit, daten, ctx, neu),
            }),
            menue(p.name, eintraege),
          ),
        );
      }),
    });
    liste.replaceChildren(wurzel);
    // Nach einer Aktion bleibt der Fokus bei der Person
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
  // append schreibt null und false als Text: nur echte Knoten übergeben
  bereich.append(
    ...[
      hinweis,
      stellvertretungen.length > 0 &&
        reihenfolgeKarte(stellvertretungen, einheit, ctx, neu),
    ].filter(Boolean),
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
    liste,
    seiten.wurzel,
  );
  // Fokus auf Pfeile der Reihenfolge nach dem Neuladen
  if (zustand.fokus?.includes(":")) {
    const ziel = bereich.querySelector(`[data-fokus="${zustand.fokus}"]`);
    if (ziel && !ziel.disabled) ziel.focus();
    else {
      const [id, richtung] = zustand.fokus.split(":");
      bereich
        .querySelector(
          `[data-fokus="${id}:${richtung === "hoch" ? "runter" : "hoch"}"]`,
        )
        ?.focus();
    }
    zustand.fokus = null;
  }
}
