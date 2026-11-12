import { anfrage, fehlertext } from "./api.js";
import { ankreuzen, chip, el, filterGruppe, tabelle, zeit } from "./dom.js";
import { formatDe, heute, verschiebe } from "./datum.js";

// Die Termine kommen aus Lodur: Titel, Zeit und Art sind hier nur zu sehen, der nächste Sync überschriebe jede Änderung. Die Verwaltung entscheidet nur, ob ein Termin «nur Leitende» ist.

const wann = (t) =>
  t.ganztaegig
    ? t.tagVon === t.tagBis
      ? formatDe(t.tagVon)
      : `${formatDe(t.tagVon)} – ${formatDe(t.tagBis)}`
    : zeit(t.beginn);

export function zeige(bereich, ctx) {
  const basis = `/api/v1/admin/einheiten/${ctx.einheit.id}`;
  const fehler = el("p", {
    class: "hinweis hinweis--fehler",
    role: "alert",
    tabindex: "-1",
    hidden: true,
  });
  const zeigeFehler = (f) => {
    fehler.textContent = typeof f === "string" ? f : fehlertext(f);
    fehler.hidden = false;
    fehler.focus();
  };

  function terminZeile(t) {
    const wahl = ankreuzen({
      label: "Nur Leitende",
      gewaehlt: t.nurLeitende,
      wert: t.id,
    });
    const schalter = wahl.eingabe;
    schalter.setAttribute("aria-label", `Nur Leitende: ${t.titel}`);
    schalter.addEventListener("change", async () => {
      fehler.hidden = true;
      schalter.disabled = true;
      try {
        await anfrage("PUT", `${basis}/termine/${t.id}`, {
          nurLeitende: schalter.checked,
        });
        ctx.melde(
          schalter.checked
            ? "Der Termin ist nur noch für Leitende sichtbar."
            : "Der Termin ist wieder für alle sichtbar.",
        );
      } catch (f) {
        schalter.checked = !schalter.checked;
        zeigeFehler(f);
      } finally {
        schalter.disabled = false;
      }
    });
    return el(
      "tr",
      {},
      el(
        "td",
        {},
        t.titel,
        t.status === "abgesagt" && [" ", chip("Abgesagt", "warn")],
      ),
      el("td", {}, wann(t)),
      el("td", {}, t.art ?? ""),
      el("td", {}, wahl.wurzel),
    );
  }

  const zeitraum = filterGruppe({
    beschriftung: "Zeitraum der Termine",
    eintraege: [
      { text: "Kommende", wert: "kommend" },
      { text: "Vergangene", wert: "vergangen" },
    ],
    beiAenderung: () => ladeTermine(),
  });
  const liste = el("div", {}, el("p", { class: "leise" }, "Lädt …"));

  async function ladeTermine() {
    const h = heute();
    const fenster =
      zeitraum.wert() === "kommend"
        ? { von: h, bis: verschiebe(h, { jahre: 1 }) }
        : {
            von: verschiebe(h, { jahre: -1 }),
            bis: verschiebe(h, { tage: -1 }),
          };
    fehler.hidden = true;
    try {
      const { termine } = await anfrage(
        "GET",
        `${basis}/termine?${new URLSearchParams(fenster)}`,
      );
      liste.replaceChildren(
        termine.length === 0
          ? el(
              "p",
              { class: "leer" },
              "Keine Termine in diesem Zeitraum. Sie erscheinen, sobald der Sync sie aus dem Terminkalender geholt hat.",
            )
          : tabelle({
              beschriftung: "Termine der Einheit",
              spalten: ["Titel", "Wann", "Art", "In der App"],
              zeilen: termine.map(terminZeile),
            }).wurzel,
      );
    } catch (f) {
      liste.replaceChildren();
      zeigeFehler(f);
    }
  }

  bereich.append(
    el(
      "p",
      { class: "hilfe" },
      "«Nur Leitende» versteckt den Termin vor Eltern und Teilnehmenden: ohne Anmeldung, Erinnerung und Push für sie. Kommando, Stellvertretung und Leitende sehen ihn weiter. Den Link zum Terminkalender trägst du unter «Einheiten» ein.",
    ),
    zeitraum.wurzel,
    fehler,
    liste,
  );
  ladeTermine();
}
