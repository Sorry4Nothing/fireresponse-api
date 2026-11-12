import { anfrage } from "./api.js";
import {
  aktionenZelle,
  ankreuzen,
  auswahl,
  bestaetigen,
  chip,
  dialogFormular,
  el,
  feld,
  knopf,
  tabelle,
} from "./dom.js";

// Kalendertage vor dem Tag des Termins, wie in der API (0 bis 7)
const ABSTAENDE = [
  [0, "Am Tag des Termins"],
  [1, "1 Tag vorher"],
  [2, "2 Tage vorher"],
  [3, "3 Tage vorher"],
  [4, "4 Tage vorher"],
  [5, "5 Tage vorher"],
  [6, "6 Tage vorher"],
  [7, "7 Tage vorher"],
];

const url = (einheit, rest = "") =>
  `/api/v1/admin/einheiten/${einheit.id}/zeitregeln${rest}`;

export function zeige(bereich, ctx) {
  const einheit = ctx.einheit;
  ctx.lade(
    () => anfrage("GET", url(einheit)),
    (daten, neu) => zeichne(bereich, ctx, einheit, daten.regeln, neu),
  );
}

function dialog({ regel, einheit, ctx, neu }) {
  const tage = auswahl({
    label: "Wie viele Tage vor dem Termin",
    optionen: ABSTAENDE.map(([n, name]) => [String(n), name]),
    wert: String(regel?.tageVorher ?? 3),
  });
  const uhrzeit = feld({
    label: "Uhrzeit (Schweizer Zeit)",
    typ: "time",
    wert: regel?.uhrzeit ?? "08:00",
    required: true,
    hilfe:
      "Zum Beispiel «3 Tage vorher» um 18:00: Bei einem Termin am Samstag geht die Erinnerung am Mittwoch um 18:00 raus.",
  });
  const text = feld({
    label: "Titel der Erinnerung",
    wert: regel?.text ?? "",
    maxlength: 150,
    required: true,
    hilfe:
      "Die fette Zeile des Pushs. {Programm} und {Datum} setzt der Server ein, zum Beispiel «Übung am Sa 31.10.: Bitte melde dich an oder ab». Keine Namen schreiben: Der Text läuft über Apple und Google.",
  });
  const beschreibung = feld({
    label: "Beschreibung (optional)",
    wert: regel?.beschreibung ?? "",
    mehrzeilig: true,
    rows: 3,
    maxlength: 300,
    hilfe:
      "Steht unter dem Titel. {Programm} und {Datum} setzt der Server auch hier ein. Keine Namen schreiben.",
  });
  const aktiv = ankreuzen({
    label: "Regel ist eingeschaltet",
    gewaehlt: regel?.aktiv ?? true,
  });
  dialogFormular({
    titel: regel ? "Erinnerung bearbeiten" : "Erinnerung anlegen",
    beschreibung:
      "Erinnert Personen, die für einen Termin noch nicht zu- oder abgesagt haben.",
    felder: [
      tage.wurzel,
      uhrzeit.wurzel,
      text.wurzel,
      beschreibung.wurzel,
      aktiv.wurzel,
    ],
    ok: regel ? "Speichern" : "Anlegen",
    senden: () => {
      const body = {
        tageVorher: Number(tage.eingabe.value),
        uhrzeit: uhrzeit.eingabe.value,
        text: text.eingabe.value.trim(),
        beschreibung: beschreibung.eingabe.value.trim() || null,
        aktiv: aktiv.eingabe.checked,
      };
      return regel
        ? anfrage("PATCH", url(einheit, `/${regel.id}`), body)
        : anfrage("POST", url(einheit), body);
    },
    danach: () => {
      neu();
      ctx.melde(regel ? "Gespeichert." : "Erinnerung ist angelegt.");
    },
  });
}

function loeschen(regel, einheit, ctx, neu) {
  bestaetigen({
    titel: "Erinnerung löschen",
    beschreibung: `«${regel.text}» wird gelöscht. Schon gesendete Erinnerungen bleiben gesendet.`,
    ok: "Löschen",
    aktion: () => anfrage("DELETE", url(einheit, `/${regel.id}`)),
    danach: () => {
      neu();
      ctx.melde("Erinnerung ist gelöscht.");
    },
  });
}

function zeichne(bereich, ctx, einheit, regeln, neu) {
  ctx.kopfAktion(
    knopf("Erinnerung anlegen", {
      art: "haupt",
      symbol: "plus",
      onclick: () => dialog({ einheit, ctx, neu }),
    }),
  );
  if (regeln.length === 0) {
    bereich.append(
      el("p", { class: "leer" }, "Es gibt noch keine Erinnerungen."),
    );
    return;
  }
  const abstandName = new Map(ABSTAENDE);
  const { wurzel } = tabelle({
    beschriftung: "Erinnerungen",
    spalten: ["Titel", "Zeitpunkt", "Status", "Aktionen"],
    zeilen: regeln.map((regel) =>
      el(
        "tr",
        { class: regel.aktiv ? undefined : "inaktiv" },
        el("th", { scope: "row" }, el("span", { class: "name" }, regel.text)),
        el(
          "td",
          {},
          `${abstandName.get(regel.tageVorher)}, ${regel.uhrzeit} Uhr`,
        ),
        el(
          "td",
          {},
          el(
            "ul",
            { class: "chips" },
            regel.aktiv
              ? chip("Ein", "ok")
              : chip("Aus", undefined, "schliessen"),
          ),
        ),
        aktionenZelle(
          knopf("Bearbeiten", {
            klein: true,
            symbol: "bearbeiten",
            kontext: regel.text,
            onclick: () => dialog({ regel, einheit, ctx, neu }),
          }),
          knopf("Löschen", {
            klein: true,
            art: "gefahr",
            symbol: "papierkorb",
            kontext: regel.text,
            onclick: () => loeschen(regel, einheit, ctx, neu),
          }),
        ),
      ),
    ),
  });
  bereich.append(
    el(
      "p",
      { class: "meta klein", role: "status" },
      regeln.length === 1 ? "1 Erinnerung" : `${regeln.length} Erinnerungen`,
    ),
    wurzel,
  );
}
