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
  knopf,
  tabelle,
  zeit,
} from "./dom.js";
import { datumfeld } from "./datumfeld.js";
import { formatDe, heute, verschiebe } from "./datum.js";

// Termine kommen aus Lodur, oder die Verwaltung legt sie selbst an, solange kein Link zum Terminkalender hinterlegt ist. Titel, Zeit und Texte der Termine aus Lodur bleiben dem Sync; die Verwaltung entscheidet nur, ob ein Termin «nur Leitende» ist. Selbst angelegte Termine ändert und löscht die Verwaltung, der Sync fasst sie nie an.

const wann = (t) =>
  t.ganztaegig
    ? t.tagVon === t.tagBis
      ? formatDe(t.tagVon)
      : `${formatDe(t.tagVon)} – ${formatDe(t.tagBis)}`
    : zeit(t.beginn);

// Schweizer Wanduhrzeit eines Zeitpunkts als [«yyyy-mm-dd», «HH:mm»]; beim Speichern rechnet der Server selbst mit Europe/Zurich
const wanduhr = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Zurich",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const inZuerich = (iso) => {
  if (!iso) return ["", ""];
  const text = wanduhr.format(new Date(iso));
  return [text.slice(0, 10), text.slice(11, 16)];
};

// Fehler aus dem Formular selbst: Der Text steht schon fertig da
class Eingabefehler extends Error {}
const formularFehler = (f) =>
  f instanceof Eingabefehler ? f.message : fehlertext(f);

const leerAlsNull = (eingabe) => eingabe.value.trim() || null;

export function zeige(bereich, ctx) {
  const basis = `/api/v1/admin/einheiten/${ctx.einheit.id}`;
  const mitLink = ctx.einheit.lodurHinterlegt === true;
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

  // Anlegen und Ändern teilen sich das Formular; bei «Anlegen» ist termin leer
  function terminDialog(termin) {
    const [vonTag, vonUhr] = inZuerich(termin?.beginn);
    const [bisTag, bisUhr] = inZuerich(termin?.ende);
    // Ein mehrtägiger Termin mit Uhrzeiten lässt sich über die API anlegen, das Formular kennt nur einen Tag: Sein Ende behält den Tag
    const endeBleibt = termin && !termin.ganztaegig && bisTag !== vonTag;
    const titel = feld({
      label: "Titel",
      wert: termin?.titel ?? "",
      maxlength: 120,
      required: true,
    });
    const ganztaegig = ankreuzen({
      label: "Ganztägig oder über mehrere Tage",
      gewaehlt: termin?.ganztaegig ?? false,
    });
    const von = datumfeld({
      label: "Datum",
      wert: (termin?.ganztaegig ? termin.tagVon : vonTag) || heute(),
    });
    const bis = datumfeld({
      label: "Bis (Datum)",
      wert: termin?.ganztaegig ? termin.tagBis : "",
    });
    const vonZeit = feld({
      label: "Beginn (Uhrzeit, Schweizer Zeit)",
      typ: "time",
      wert: vonUhr || "18:30",
    });
    const bisZeit = feld({
      label: "Ende (Uhrzeit, Schweizer Zeit)",
      typ: "time",
      wert: bisUhr || "20:30",
    });
    const art = feld({
      label: "Art (optional)",
      wert: termin?.art ?? "",
      maxlength: 120,
      hilfe: "Zum Beispiel Übung, Sitzung oder Anlass.",
    });
    const ort = feld({
      label: "Ort (optional)",
      wert: termin?.ort ?? "",
      maxlength: 120,
    });
    const thema = feld({
      label: "Thema (optional)",
      wert: termin?.thema ?? "",
      mehrzeilig: true,
      rows: 2,
      maxlength: 2000,
    });
    const info = feld({
      label: "Info (optional)",
      wert: termin?.info ?? "",
      mehrzeilig: true,
      rows: 2,
      maxlength: 2000,
    });
    const aufgebot = feld({
      label: "Aufgebot (optional)",
      wert: termin?.aufgebot ?? "",
      mehrzeilig: true,
      rows: 2,
      maxlength: 2000,
      hilfe:
        "Wann und wo die Gruppe antritt. Eltern und Teilnehmende sehen es in der App.",
    });
    const nurLeitende = ankreuzen({
      label: "Nur Leitende (für Eltern und Teilnehmende unsichtbar)",
      gewaehlt: termin?.nurLeitende ?? false,
    });
    const hoechstzahl = feld({
      label: "Höchstzahl Leitende (optional)",
      typ: "number",
      wert: termin?.leitungHoechstzahl ?? "",
      min: 1,
      max: 500,
      step: 1,
      inputmode: "numeric",
      hilfe:
        "Wie viele Kommando, Stellvertretungen und Leitende sich höchstens anmelden können. Weitere kommen auf eine Warteliste und rücken nach, sobald ein Platz frei wird. Leer lassen: keine Grenze.",
    });

    // Ganztägig: Datum bis statt Uhrzeiten
    const zeigeZeiten = () => {
      const ganz = ganztaegig.eingabe.checked;
      bis.wurzel.hidden = !ganz;
      vonZeit.wurzel.hidden = bisZeit.wurzel.hidden = ganz;
    };
    ganztaegig.eingabe.addEventListener("change", zeigeZeiten);
    zeigeZeiten();

    dialogFormular({
      titel: termin ? "Termin ändern" : "Termin anlegen",
      beschreibung: "Der Termin erscheint in der App wie die aus Lodur.",
      felder: [
        titel.wurzel,
        ganztaegig.wurzel,
        von.wurzel,
        bis.wurzel,
        vonZeit.wurzel,
        bisZeit.wurzel,
        art.wurzel,
        ort.wurzel,
        thema.wurzel,
        info.wurzel,
        aufgebot.wurzel,
        nurLeitende.wurzel,
        hoechstzahl.wurzel,
      ],
      ok: termin ? "Speichern" : "Anlegen",
      fehlertext: formularFehler,
      senden: () => {
        const tagVon = von.eingabe.value;
        if (!tagVon) throw new Eingabefehler("Bitte ein Datum angeben.");
        let zeitpunkte;
        if (ganztaegig.eingabe.checked) {
          const tagBis = bis.eingabe.value || tagVon;
          if (tagBis < tagVon) {
            throw new Eingabefehler("Das Ende liegt vor dem Beginn.");
          }
          zeitpunkte = { ganztaegig: true, tagVon, tagBis };
        } else {
          if (!vonZeit.eingabe.value || !bisZeit.eingabe.value) {
            throw new Eingabefehler(
              "Bitte Beginn und Ende mit Uhrzeit angeben.",
            );
          }
          const beginn = `${tagVon}T${vonZeit.eingabe.value}`;
          const ende = `${endeBleibt ? bisTag : tagVon}T${bisZeit.eingabe.value}`;
          if (ende <= beginn) {
            throw new Eingabefehler("Das Ende muss nach dem Beginn liegen.");
          }
          zeitpunkte = { ganztaegig: false, beginn, ende };
        }
        const roh = hoechstzahl.eingabe.value.trim();
        const grenze = roh === "" ? null : Number(roh);
        if (
          grenze !== null &&
          !(Number.isInteger(grenze) && grenze >= 1 && grenze <= 500)
        ) {
          throw new Eingabefehler(
            "Die Höchstzahl ist eine ganze Zahl von 1 bis 500.",
          );
        }
        const body = {
          titel: titel.eingabe.value.trim(),
          ...zeitpunkte,
          art: leerAlsNull(art.eingabe),
          ort: leerAlsNull(ort.eingabe),
          thema: leerAlsNull(thema.eingabe),
          info: leerAlsNull(info.eingabe),
          aufgebot: leerAlsNull(aufgebot.eingabe),
          nurLeitende: nurLeitende.eingabe.checked,
          leitungHoechstzahl: grenze,
        };
        return termin
          ? anfrage("PUT", `${basis}/termine/${termin.id}`, body)
          : anfrage("POST", `${basis}/termine`, body);
      },
      danach: () => {
        ctx.melde(termin ? "Gespeichert." : "Der Termin ist angelegt.");
        ladeTermine();
      },
    });
  }

  function loeschen(t) {
    bestaetigen({
      titel: "Termin löschen",
      beschreibung: `«${t.titel}» wird gelöscht, mit allen Antworten. Ist der Termin noch nicht vorbei, bekommen alle der Einheit eine Absage per Push.`,
      ok: "Löschen",
      aktion: () => anfrage("DELETE", `${basis}/termine/${t.id}`),
      danach: () => {
        ctx.melde("Der Termin ist gelöscht.");
        ladeTermine();
      },
    });
  }

  // Belegte Plätze der Leitenden; «Voll» trägt ein Symbol, nie nur Farbe
  function platzZelle(t) {
    const p = t.leitungPlaetze;
    if (!p) {
      return el(
        "td",
        {},
        t.quelle === "manuell"
          ? "Keine Grenze"
          : [
              el("span", { "aria-hidden": "true" }, "–"),
              el("span", { class: "nur-leser" }, "Nicht begrenzt"),
            ],
      );
    }
    return el(
      "td",
      {},
      `${p.belegt} von ${p.hoechstzahl} belegt`,
      p.wartende > 0 && `, ${p.wartende} auf der Warteliste`,
      p.voll && el("ul", { class: "chips" }, chip("Voll", "warn")),
    );
  }

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
    const manuell = t.quelle === "manuell";
    return el(
      "tr",
      {},
      el(
        "td",
        {},
        t.titel,
        t.status === "abgesagt" &&
          el("ul", { class: "chips" }, chip("Abgesagt", "warn")),
      ),
      el("td", {}, wann(t)),
      el("td", {}, t.art ?? ""),
      el("td", {}, manuell ? "Selbst angelegt" : "Aus Lodur"),
      platzZelle(t),
      el("td", {}, wahl.wurzel),
      manuell
        ? aktionenZelle(
            knopf("Ändern", {
              klein: true,
              symbol: "bearbeiten",
              kontext: t.titel,
              onclick: () => terminDialog(t),
            }),
            knopf("Löschen", {
              klein: true,
              art: "gefahr",
              symbol: "papierkorb",
              kontext: t.titel,
              onclick: () => loeschen(t),
            }),
          )
        : el("td", {}),
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
              mitLink
                ? "Keine Termine in diesem Zeitraum. Sie erscheinen, sobald der Sync sie aus dem Terminkalender geholt hat."
                : "Keine Termine in diesem Zeitraum. Mit «Termin anlegen» erfasst du einen.",
            )
          : tabelle({
              beschriftung: "Termine der Einheit",
              spalten: [
                "Titel",
                "Wann",
                "Art",
                "Quelle",
                "Leiter-Plätze",
                "In der App",
                "Aktionen",
              ],
              zeilen: termine.map(terminZeile),
            }).wurzel,
      );
    } catch (f) {
      liste.replaceChildren();
      zeigeFehler(f);
    }
  }

  // Selbst angelegte Termine gibt es nur ohne Link: Sonst wüsste niemand, welcher Termin gilt
  if (!mitLink) {
    ctx.kopfAktion(
      knopf("Termin anlegen", {
        art: "haupt",
        symbol: "plus",
        onclick: () => terminDialog(),
      }),
    );
  }
  bereich.append(
    el(
      "p",
      { class: "hilfe" },
      mitLink
        ? "Die Termine kommen aus dem Terminkalender (Lodur). Titel, Zeit und Texte ändert der Sync. Eigene Termine legst du erst an, wenn du den Link unter «Einheiten» entfernst. «Nur Leitende» versteckt den Termin vor Eltern und Teilnehmenden: ohne Anmeldung, Erinnerung und Push für sie. Kommando, Stellvertretung und Leitende sehen ihn weiter."
        : "Du legst die Termine selbst an, solange unter «Einheiten» kein Link zum Terminkalender hinterlegt ist. Ändert oder löschst du einen Termin, melden wir es per Push allen, die schon geantwortet haben (bei einer Absage allen der Einheit). «Nur Leitende» versteckt den Termin vor Eltern und Teilnehmenden: ohne Anmeldung, Erinnerung und Push für sie.",
    ),
    zeitraum.wurzel,
    fehler,
    liste,
  );
  ladeTermine();
}
