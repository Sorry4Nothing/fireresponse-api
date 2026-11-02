import { anfrage, ApiFehler } from "./api.js";
import { bestaetigen, chip, el, geheimnisDialog, tag } from "./dom.js";

// Aktionen und Zustände, die für jedes Konto gleich sind: Personen (Kommando, Stellvertretungen, Leitende) und die Konten der Teilnehmenden. Welche Aktion ein Konto bekommt, sagt die API in konto.aktionen; fehlt sie dort, fehlt der Knopf.

const url = (einheit, konto, aktion) =>
  `/api/v1/admin/einheiten/${einheit.id}/personen/${konto.id}${aktion ? `/${aktion}` : ""}`;

// Chips mit Symbol und Wort; der Zustand steht nie nur in der Farbe
export function zustandsChips(konto, { verwaltung = false } = {}) {
  const liste = [
    verwaltung && chip("Verwaltung", undefined, "stern"),
    konto.zweiterFaktor && chip("Zweiter Faktor", "ok", "schild"),
  ];
  if (konto.startpasswort) {
    const frist = konto.startpasswort.gueltigBis;
    liste.push(
      konto.startpasswort.abgelaufen
        ? chip("Startpasswort abgelaufen", "fehler", "uhr")
        : chip(`Startpasswort bis ${tag(frist)}`, "warn", "schluessel"),
    );
  }
  if (konto.deaktiviert) liste.push(chip("Deaktiviert", "fehler", "sperre"));
  if (konto.eigenes) liste.push(chip("Das bist du", undefined, "info"));
  return liste.filter(Boolean);
}

const dialogText = (konto) =>
  `Gib das Startpasswort für «${konto.name}» sicher weiter. Es gilt 7 Tage. Es steht nur in diesem Fenster und ist weg, sobald du es schliesst; solange es offen ist, zeigt die Verwaltung es dir wieder an.`;

// Zeigt das offene Startpasswort; ist keines mehr offen, sagt die API es (409)
export async function startpasswortAnzeigen(konto, einheit, ctx) {
  try {
    const { startpasswort } = await anfrage(
      "GET",
      url(einheit, konto, "startpasswort"),
    );
    geheimnisDialog({
      titel: "Startpasswort",
      beschreibung: dialogText(konto),
      wert: startpasswort,
    });
  } catch (f) {
    ctx.melde(
      f instanceof ApiFehler && f.code === "KEIN_STARTPASSWORT"
        ? "Es ist kein Startpasswort mehr offen. Erzeuge ein neues."
        : "Das Startpasswort lässt sich nicht anzeigen.",
      "fehler",
    );
  }
}

// neu(): lädt die Ansicht nochmals; fertig(): schliesst ein Seitenblatt, dessen Angaben danach veraltet sind
export function startpasswortNeu(konto, einheit, ctx, neu, fertig = () => {}) {
  bestaetigen({
    titel: "Neues Startpasswort erzeugen",
    beschreibung: `«${konto.name}» wird überall abgemeldet und muss beim nächsten Login ein neues Passwort wählen. Das Startpasswort gilt 7 Tage.`,
    ok: "Startpasswort erzeugen",
    gefaehrlich: false,
    aktion: () => anfrage("POST", url(einheit, konto, "startpasswort")),
    danach: (antwort) => {
      neu();
      ctx.melde(`Neues Startpasswort für «${konto.name}» ist erzeugt.`);
      geheimnisDialog({
        titel: "Startpasswort",
        beschreibung: dialogText(konto),
        wert: antwort.startpasswort,
      });
      fertig();
    },
  });
}

export function deaktivieren(konto, einheit, ctx, neu, fertig = () => {}) {
  bestaetigen({
    titel: "Konto deaktivieren",
    beschreibung: `«${konto.name}» kann sich nicht mehr anmelden und wird überall abgemeldet. Das Profilbild wird gelöscht. Das Konto lässt sich wieder aktivieren.`,
    ok: "Deaktivieren",
    aktion: () => anfrage("POST", url(einheit, konto, "deaktivieren")),
    danach: () => {
      neu();
      ctx.melde(`«${konto.name}» ist deaktiviert.`);
      fertig();
    },
  });
}

export function aktivieren(konto, einheit, ctx, neu, fertig = () => {}) {
  bestaetigen({
    titel: "Konto aktivieren",
    beschreibung: `«${konto.name}» kann sich wieder anmelden.`,
    ok: "Aktivieren",
    gefaehrlich: false,
    aktion: () => anfrage("POST", url(einheit, konto, "aktivieren")),
    danach: () => {
      neu();
      ctx.melde(`«${konto.name}» ist aktiviert.`);
      fertig();
    },
  });
}

export function faktorZuruecksetzen(
  konto,
  einheit,
  ctx,
  neu,
  fertig = () => {},
) {
  bestaetigen({
    titel: "Zweiten Faktor zurücksetzen",
    beschreibung: `«${konto.name}» muss den zweiten Faktor danach neu einrichten und kommt bis dahin nicht in die Verwaltung.`,
    ok: "Zurücksetzen",
    aktion: () =>
      anfrage("POST", url(einheit, konto, "zweiter-faktor-zuruecksetzen")),
    danach: () => {
      neu();
      ctx.melde(`Der zweite Faktor von «${konto.name}» ist zurückgesetzt.`);
      fertig();
    },
  });
}

// Einträge für das Menü «Mehr» einer Zeile, nur die Aktionen, die die API erlaubt
export function kontoMenueEintraege(konto, einheit, ctx, neu, fertig) {
  const a = konto.aktionen;
  return [
    a.startpasswort &&
      konto.startpasswort &&
      !konto.startpasswort.abgelaufen && {
        text: "Startpasswort anzeigen",
        onclick: () => startpasswortAnzeigen(konto, einheit, ctx),
      },
    a.startpasswort && {
      text: "Neues Startpasswort",
      onclick: () => startpasswortNeu(konto, einheit, ctx, neu, fertig),
    },
    a.zweiterFaktor &&
      konto.zweiterFaktor && {
        text: "Zweiten Faktor zurücksetzen",
        onclick: () => faktorZuruecksetzen(konto, einheit, ctx, neu, fertig),
      },
    a.deaktivieren &&
      (konto.deaktiviert
        ? {
            text: "Aktivieren",
            onclick: () => aktivieren(konto, einheit, ctx, neu, fertig),
          }
        : {
            text: "Deaktivieren",
            gefaehrlich: true,
            onclick: () => deaktivieren(konto, einheit, ctx, neu, fertig),
          }),
  ];
}

// Gelber Hinweis oben: offene Aufgaben; ohne Aufgaben kein Element
export function aufgabenHinweis(zeilen) {
  const offen = zeilen.filter(Boolean);
  if (offen.length === 0) return null;
  return el(
    "div",
    { class: "hinweis hinweis--warn", role: "status" },
    el(
      "ul",
      { class: "aufgaben" },
      offen.map((text) => el("li", {}, text)),
    ),
  );
}

export const mehrzahl = (n, einzahl, mehrfach) =>
  `${n} ${n === 1 ? einzahl : mehrfach}`;

// Die Felder für ein neues Konto sind überall gleich
export const BENUTZERNAME_HILFE =
  "3 bis 64 Zeichen: Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich. Gross- und Kleinschreibung zählt nicht.";
