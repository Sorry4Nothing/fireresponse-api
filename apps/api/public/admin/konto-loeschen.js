import { anfrage, fehlertext } from "./api.js";
import { bestaetigen, el, feld } from "./dom.js";
import { panel, werte } from "./system.js";

const ROLLEN = {
  kommandant: "Kommandantin oder Kommandant",
  stellvertretung: "Stellvertretung",
  leitung: "Leitung",
  eltern: "Eltern einer teilnehmenden Person",
  selbst: "Teilnehmende Person mit eigenem Konto",
};

// Konto löschen: suchen, ansehen, nach Rückfrage löschen. Die Person löscht ihr Konto nie selbst; die Liste aller Personen folgt mit der Personenverwaltung
export function zeige(bereich, ctx) {
  const name = feld({
    label: "Benutzername",
    hilfe: "Der genaue Benutzername des Kontos.",
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: "false",
    required: true,
  });
  const fehler = el("p", {
    class: "hinweis hinweis--fehler",
    role: "alert",
    hidden: true,
    tabindex: "-1",
  });
  const treffer = el("div", {});
  const suchen = el(
    "button",
    { type: "submit", class: "knopf knopf--haupt" },
    "Konto suchen",
  );
  const formular = el(
    "form",
    { class: "formular", novalidate: true },
    name.wurzel,
    fehler,
    suchen,
  );

  function zeigeTreffer(konto) {
    const loeschen = el(
      "button",
      { type: "button", class: "knopf knopf--gefahr" },
      "Konto löschen",
    );
    loeschen.addEventListener("click", () =>
      bestaetigen({
        titel: "Konto löschen?",
        beschreibung: `Das Konto «${konto.benutzername}» (${konto.name}) wird endgültig gelöscht, samt Anmeldung, Sitzungen, Profilbild, Push-Tokens und Rollen. Das lässt sich nicht rückgängig machen. Teilnehmende Personen und ihre Anmeldungen bleiben.`,
        ok: "Konto endgültig löschen",
        aktion: () => anfrage("DELETE", `/api/v1/admin/konten/${konto.id}`),
        danach: () => {
          treffer.replaceChildren();
          name.eingabe.value = "";
          ctx.melde(`Das Konto «${konto.benutzername}» wurde gelöscht.`);
          name.eingabe.focus();
        },
      }),
    );
    treffer.replaceChildren(
      panel(
        konto.name,
        werte([
          ["Benutzername", konto.benutzername],
          ...konto.einheiten.map((e) => [
            e.einheitName,
            ROLLEN[e.rolle] ?? e.rolle,
          ]),
        ]),
        loeschen,
      ),
    );
  }

  formular.addEventListener("submit", async (ereignis) => {
    ereignis.preventDefault();
    fehler.hidden = true;
    treffer.replaceChildren();
    const wert = name.eingabe.value.trim();
    if (!wert) {
      fehler.textContent = "Bitte gib den Benutzernamen ein.";
      fehler.hidden = false;
      fehler.focus();
      return;
    }
    suchen.disabled = true;
    try {
      zeigeTreffer(
        await anfrage(
          "GET",
          `/api/v1/admin/konten?benutzername=${encodeURIComponent(wert)}`,
        ),
      );
    } catch (f) {
      fehler.textContent =
        f.status === 404
          ? "Zu diesem Benutzernamen gibt es kein Konto, das du löschen darfst."
          : fehlertext(f);
      fehler.hidden = false;
      fehler.focus();
    } finally {
      suchen.disabled = false;
    }
  });

  bereich.append(formular, treffer);
}
