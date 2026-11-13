import { anfrage, fehlertext } from "./api.js";
import {
  bestaetigen,
  chip,
  dialogFormular,
  el,
  feld,
  knopf,
  zeit,
} from "./dom.js";
import { panel } from "./system.js";

// Wartungsmodus: Solange er läuft, antwortet die API den Apps mit 503; die Verwaltung bleibt benutzbar. Der Stand kommt aus dem öffentlichen Status, geschaltet wird über die Systemroute.

// Wert für ein datetime-local-Feld (Ortszeit des Browsers)
function lokal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
}

const schalten = (body) => anfrage("PUT", "/api/v1/admin/system/wartung", body);

export function wartungPanel(ctx) {
  const inhalt = el("div", { class: "aktionen aktionen--unten" });
  const stand = el("div", { class: "meta", role: "status" });

  function einschalten(aktuell) {
    const text = feld({
      label: "Text für die Apps (optional)",
      wert: aktuell.text ?? "",
      mehrzeilig: true,
      rows: 3,
      maxlength: 280,
      hilfe:
        "Höchstens 280 Zeichen. Ohne Text zeigen die Apps ihren Standardtext. Keine Namen schreiben.",
    });
    const ende = feld({
      label: "Voraussichtliches Ende (optional)",
      typ: "datetime-local",
      wert: lokal(aktuell.ende),
      hilfe:
        "Nur zur Anzeige: Die Wartung endet erst, wenn du sie hier ausschaltest.",
    });
    dialogFormular({
      titel: aktuell.aktiv ? "Wartung bearbeiten" : "Wartung einschalten",
      beschreibung:
        "Solange die Wartung läuft, sind die Apps gesperrt und zeigen den Wartungsbildschirm. Die Verwaltung bleibt benutzbar.",
      felder: [text.wurzel, ende.wurzel],
      ok: aktuell.aktiv ? "Speichern" : "Wartung einschalten",
      gefaehrlich: !aktuell.aktiv,
      senden: () =>
        schalten({
          aktiv: true,
          text: text.eingabe.value.trim() || null,
          ende: ende.eingabe.value
            ? new Date(ende.eingabe.value).toISOString()
            : null,
        }),
      danach: () => {
        lade();
        ctx.melde(
          aktuell.aktiv ? "Gespeichert." : "Wartung ist eingeschaltet.",
        );
      },
    });
  }

  function zeichne(aktuell) {
    const knoepfe = aktuell.aktiv
      ? [
          knopf("Bearbeiten", { onclick: () => einschalten(aktuell) }),
          knopf("Wartung ausschalten", {
            art: "haupt",
            onclick: () =>
              bestaetigen({
                titel: "Wartung ausschalten",
                beschreibung: "Die Apps funktionieren danach wieder.",
                ok: "Ausschalten",
                gefaehrlich: false,
                aktion: () => schalten({ aktiv: false }),
                danach: () => {
                  lade();
                  ctx.melde("Wartung ist ausgeschaltet.");
                },
              }),
          }),
        ]
      : [
          knopf("Wartung einschalten", {
            onclick: () => einschalten(aktuell),
          }),
        ];
    stand.replaceChildren(
      el(
        "ul",
        { class: "chips" },
        aktuell.aktiv
          ? chip("Wartung läuft", "warn")
          : chip("Wartung ist aus", "ok"),
      ),
      el(
        "p",
        {},
        aktuell.aktiv
          ? `Seit ${zeit(aktuell.seit)}${aktuell.ende ? `, voraussichtlich bis ${zeit(aktuell.ende)}` : ""}.${aktuell.text ? ` Text: «${aktuell.text}»` : ""}`
          : "Die Apps laufen normal.",
      ),
    );
    inhalt.replaceChildren(...knoepfe);
  }

  async function lade() {
    try {
      zeichne(await anfrage("GET", "/api/v1/wartung"));
    } catch (f) {
      stand.replaceChildren(fehlertext(f));
    }
  }
  lade();
  return panel("Wartung", stand, inhalt);
}
