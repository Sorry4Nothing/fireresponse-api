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

// ISO: 1 Montag bis 7 Sonntag, wie in der API
const WOCHENTAGE = [
  [1, "Montag"],
  [2, "Dienstag"],
  [3, "Mittwoch"],
  [4, "Donnerstag"],
  [5, "Freitag"],
  [6, "Samstag"],
  [7, "Sonntag"],
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
  const wochentag = auswahl({
    label: "Wochentag",
    optionen: WOCHENTAGE.map(([w, name]) => [String(w), name]),
    wert: String(regel?.wochentag ?? 3),
  });
  const uhrzeit = feld({
    label: "Uhrzeit (Schweizer Zeit)",
    typ: "time",
    wert: regel?.uhrzeit ?? "08:00",
    required: true,
    hilfe:
      "Die Erinnerung geht zum letzten passenden Zeitpunkt vor dem Termin.",
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
      wochentag.wurzel,
      uhrzeit.wurzel,
      text.wurzel,
      beschreibung.wurzel,
      aktiv.wurzel,
    ],
    ok: regel ? "Speichern" : "Anlegen",
    senden: () => {
      const body = {
        wochentag: Number(wochentag.eingabe.value),
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
  const tagName = new Map(WOCHENTAGE);
  const { wurzel } = tabelle({
    beschriftung: "Erinnerungen",
    spalten: ["Titel", "Zeitpunkt", "Status", "Aktionen"],
    zeilen: regeln.map((regel) =>
      el(
        "tr",
        { class: regel.aktiv ? undefined : "inaktiv" },
        el("th", { scope: "row" }, el("span", { class: "name" }, regel.text)),
        el("td", {}, `${tagName.get(regel.wochentag)}, ${regel.uhrzeit} Uhr`),
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
