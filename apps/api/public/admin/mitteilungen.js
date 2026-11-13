import { anfrage } from "./api.js";
import { auswahl, bestaetigen, el, feld, neueId } from "./dom.js";
import { panel } from "./system.js";

// Push-Mitteilung: freier Text an die Konten der gewählten Einheit, sofort und einmalig. Grenzen wie in der API (60 und 200 Zeichen)
const MAX_TITEL = 60;
const MAX_TEXT = 200;

const GRUPPEN = {
  alle: "Ganze Einheit (Kommando, Leitende, Eltern und teilnehmende Personen)",
  leitende: "Nur Leitende (Kommando, Stellvertretungen und Leitende)",
};

// Zeichenzähler unter dem Feld; hängt sich an aria-describedby, ohne bei jedem Tastendruck vorgelesen zu werden
function mitZaehler(f, max) {
  const id = neueId("zaehler");
  const zaehler = el("p", { class: "hilfe", id });
  const zeichne = () => {
    zaehler.textContent = `${[...f.eingabe.value].length} von ${max} Zeichen`;
  };
  f.eingabe.setAttribute(
    "aria-describedby",
    `${f.eingabe.getAttribute("aria-describedby") ?? ""} ${id}`.trim(),
  );
  f.eingabe.addEventListener("input", zeichne);
  zeichne();
  f.wurzel.append(zaehler);
  return { zeichne };
}

export function zeige(bereich, ctx) {
  const gruppe = auswahl({
    label: "Empfänger",
    optionen: Object.entries(GRUPPEN),
    wert: "alle",
  });
  const titel = feld({
    label: "Titel",
    maxlength: MAX_TITEL,
    required: true,
    autocomplete: "off",
    hilfe: "Die fette Zeile des Pushs.",
  });
  const text = feld({
    label: "Text",
    mehrzeilig: true,
    rows: 4,
    maxlength: MAX_TEXT,
    required: true,
    hilfe: "Nur Text. Zeilenumbrüche sind möglich.",
  });
  const titelZaehler = mitZaehler(titel, MAX_TITEL);
  const textZaehler = mitZaehler(text, MAX_TEXT);
  const fehler = el("p", {
    class: "hinweis hinweis--fehler",
    role: "alert",
    hidden: true,
    tabindex: "-1",
  });
  const zeigeFehler = (meldung) => {
    fehler.textContent = meldung;
    fehler.hidden = false;
    fehler.focus();
  };
  const senden = el(
    "button",
    { type: "submit", class: "knopf knopf--haupt" },
    "Mitteilung senden",
  );
  const formular = el(
    "form",
    { class: "formular", novalidate: true },
    el(
      "p",
      { class: "hinweis hinweis--warn" },
      "Der Text steht auf dem Sperrbildschirm und läuft über Google und Apple. Schreibe keine Namen von Kindern und keine Personendaten hinein.",
    ),
    gruppe.wurzel,
    titel.wurzel,
    text.wurzel,
    fehler,
    senden,
  );

  formular.addEventListener("submit", (ereignis) => {
    ereignis.preventDefault();
    fehler.hidden = true;
    const t = titel.eingabe.value.trim();
    const x = text.eingabe.value.trim();
    if (!t || !x) {
      zeigeFehler("Bitte gib Titel und Text ein.");
      (t ? text : titel).eingabe.focus();
      return;
    }
    const empfaenger = gruppe.eingabe.value;
    bestaetigen({
      titel: "Mitteilung jetzt senden?",
      beschreibung: `Die Mitteilung geht sofort an: ${GRUPPEN[empfaenger]}, Einheit «${ctx.einheit.name}». Sie lässt sich nicht zurückholen. Titel: «${t}». Text: «${x}»`,
      ok: "Jetzt senden",
      gefaehrlich: false,
      aktion: () =>
        anfrage(
          "POST",
          `/api/v1/admin/einheiten/${ctx.einheit.id}/mitteilungen`,
          { gruppe: empfaenger, titel: t, text: x },
        ),
      danach: ({ empfaenger: n }) => {
        if (n === 0) {
          ctx.melde(
            "Niemand erreicht: Kein Konto dieser Gruppe hat ein Gerät für Push angemeldet. Es wurde nichts gesendet.",
            "warn",
          );
          return;
        }
        titel.eingabe.value = "";
        text.eingabe.value = "";
        titelZaehler.zeichne();
        textZaehler.zeichne();
        ctx.melde(
          n === 1 ? "Gesendet an 1 Konto." : `Gesendet an ${n} Konten.`,
        );
        titel.eingabe.focus();
      },
    });
  });

  bereich.append(
    el(
      "p",
      { class: "hilfe" },
      "Eine Push-Mitteilung geht an alle Konten der Einheit mit einem angemeldeten Gerät. Die Schalter der Konten für Programm-Pushes gelten hier nicht. Sie wird sofort gesendet, nicht geplant und nicht wiederholt. Pro Konto sind höchstens 5 Mitteilungen pro Stunde und 20 pro Tag möglich. Im Protokoll steht, wer wann an wen gesendet hat, nie der Text.",
    ),
    panel("Neue Mitteilung", formular),
  );
}
