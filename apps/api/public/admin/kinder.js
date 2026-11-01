import { anfrage } from "./api.js";
import {
  aktionenZelle,
  ankreuzen,
  auswahl,
  chip,
  dialogFormular,
  el,
  feld,
  filterGruppe,
  gruppe,
  icon,
  knopf,
  neueId,
  seitenwahl,
  tabelle,
} from "./dom.js";

export function zeige(bereich, ctx) {
  ctx.lade(
    async () => {
      const [kinder, personen, stufen] = await Promise.all([
        anfrage("GET", "/api/v1/admin/kinder"),
        anfrage("GET", "/api/v1/admin/personen"),
        anfrage("GET", "/api/v1/stufen"),
      ]);
      return {
        kinder: kinder.kinder,
        personen: personen.personen,
        stufen: stufen.stufen,
      };
    },
    (daten, neu) => zeichne(bereich, ctx, daten, neu),
  );
}

const stufenOptionen = (stufen) => stufen.map((s) => [s.id, s.name]);

function anlegen(daten, ctx, neu) {
  const vorname = feld({ label: "Vorname", maxlength: 100, required: true });
  const nachname = feld({ label: "Nachname", maxlength: 100, required: true });
  const stufe = auswahl({
    label: "Stufe",
    optionen: stufenOptionen(daten.stufen),
    wert: daten.stufen[0]?.id ?? "",
  });
  dialogFormular({
    titel: "Kind anlegen",
    beschreibung: "Elternteile verknüpfst du danach beim Bearbeiten.",
    felder: [vorname.wurzel, nachname.wurzel, stufe.wurzel],
    ok: "Anlegen",
    senden: () =>
      anfrage("POST", "/api/v1/admin/kinder", {
        vorname: vorname.eingabe.value.trim(),
        nachname: nachname.eingabe.value.trim(),
        stufeId: stufe.eingabe.value,
      }),
    danach: () => {
      neu();
      ctx.melde("Kind ist angelegt.");
    },
  });
}

function bearbeiten(kind, daten, ctx, neu) {
  const vorname = feld({
    label: "Vorname",
    wert: kind.vorname,
    maxlength: 100,
    required: true,
  });
  const nachname = feld({
    label: "Nachname",
    wert: kind.nachname,
    maxlength: 100,
    required: true,
  });
  const stufe = auswahl({
    label: "Stufe",
    optionen: stufenOptionen(daten.stufen),
    wert: kind.stufeId,
  });
  const aktiv = ankreuzen({ label: "Aktiv", gewaehlt: kind.aktiv });
  const boxen = daten.personen.map((person) =>
    ankreuzen({
      label: `${person.name} (${person.benutzername ?? "ohne Benutzernamen"})`,
      gewaehlt: kind.eltern.includes(person.id),
      wert: person.id,
    }),
  );
  dialogFormular({
    titel: "Kind bearbeiten",
    beschreibung: `${kind.vorname} ${kind.nachname}`,
    felder: [
      vorname.wurzel,
      nachname.wurzel,
      stufe.wurzel,
      aktiv.wurzel,
      gruppe(
        "Elternteile (höchstens 10)",
        boxen.map((b) => b.wurzel),
        { scrollen: true },
      ),
    ],
    ok: "Speichern",
    senden: () =>
      anfrage("PATCH", `/api/v1/admin/kinder/${kind.id}`, {
        vorname: vorname.eingabe.value.trim(),
        nachname: nachname.eingabe.value.trim(),
        stufeId: stufe.eingabe.value,
        aktiv: aktiv.eingabe.checked,
        eltern: boxen
          .filter((b) => b.eingabe.checked)
          .map((b) => b.eingabe.value),
      }),
    danach: () => {
      neu();
      ctx.melde("Gespeichert.");
    },
  });
}

function elternZelle(kind, personen) {
  if (kind.eltern.length === 0) {
    return el("ul", { class: "chips" }, chip("Keine Eltern verknüpft", "warn"));
  }
  return el(
    "ul",
    { class: "zeilen" },
    kind.eltern.map((id) => {
      const person = personen.get(id);
      return el(
        "li",
        { class: "eltern-zeile" },
        person?.name ?? "Person",
        person?.deaktiviert &&
          el("ul", { class: "chips" }, chip("Konto deaktiviert", "fehler")),
      );
    }),
  );
}

function zeichne(bereich, ctx, daten, neu) {
  const stufenname = new Map(daten.stufen.map((s) => [s.id, s.name]));
  const personen = new Map(daten.personen.map((p) => [p.id, p]));
  const { wurzel, koerper } = tabelle({
    beschriftung: "Kinder",
    spalten: ["Kind", "Stufe", "Eltern", "Status", "Aktionen"],
    zeilen: daten.kinder.map((kind) => {
      const name = `${kind.vorname} ${kind.nachname}`;
      return el(
        "tr",
        {
          class: kind.aktiv ? undefined : "inaktiv",
          "data-suche": name.toLowerCase(),
          "data-stufe": kind.stufeId,
        },
        el("th", { scope: "row" }, el("span", { class: "name" }, name)),
        el(
          "td",
          {},
          el(
            "ul",
            { class: "chips" },
            chip(stufenname.get(kind.stufeId) ?? "Ohne Stufe", "stufe"),
          ),
        ),
        el("td", {}, elternZelle(kind, personen)),
        el(
          "td",
          {},
          el(
            "ul",
            { class: "chips" },
            kind.aktiv
              ? chip("Aktiv", "ok")
              : chip("Inaktiv", undefined, "schliessen"),
          ),
        ),
        aktionenZelle(
          knopf("Bearbeiten", {
            klein: true,
            symbol: "bearbeiten",
            kontext: name,
            onclick: () => bearbeiten(kind, daten, ctx, neu),
          }),
        ),
      );
    }),
  });
  ctx.kopfAktion(
    daten.stufen.length > 0
      ? knopf("Kind anlegen", {
          art: "haupt",
          symbol: "plus",
          onclick: () => anlegen(daten, ctx, neu),
        })
      : el("p", { class: "hilfe" }, "Lege zuerst eine Stufe an."),
  );

  const ohneEltern = daten.kinder.filter((k) => k.eltern.length === 0).length;
  const zaehler = el("p", { class: "meta klein", role: "status" });
  const sucheId = neueId("suche");
  const suche = el("input", {
    id: sucheId,
    class: "eingabe",
    type: "search",
    placeholder: "Name",
    autocomplete: "off",
  });
  const seiten = seitenwahl({ beiWechsel: aktualisiere });
  const vonVorn = () => {
    seiten.anfang();
    aktualisiere();
  };
  const filter =
    daten.stufen.length > 0
      ? filterGruppe({
          beschriftung: "Stufe",
          eintraege: [
            { text: "Alle", n: daten.kinder.length, wert: "" },
            ...daten.stufen.map((s) => ({
              text: s.name,
              n: daten.kinder.filter((k) => k.stufeId === s.id).length,
              wert: s.id,
            })),
          ],
          beiAenderung: vonVorn,
        })
      : null;
  function aktualisiere() {
    const frage = suche.value.trim().toLowerCase();
    const stufe = filter?.wert() ?? "";
    const treffer = [...koerper.children].filter(
      (eintrag) =>
        eintrag.dataset.suche.includes(frage) &&
        (stufe === "" || eintrag.dataset.stufe === stufe),
    );
    const [von, bis] = seiten.fenster(treffer.length);
    const sichtbar = new Set(treffer.slice(von, bis));
    for (const eintrag of koerper.children) {
      eintrag.hidden = !sichtbar.has(eintrag);
    }
    zaehler.textContent = `${treffer.length} von ${daten.kinder.length} Kindern`;
  }
  suche.addEventListener("input", vonVorn);
  aktualisiere();
  bereich.append(
    ...[
      ohneEltern > 0 &&
        el(
          "p",
          { class: "hinweis hinweis--warn" },
          ohneEltern === 1
            ? "1 Kind hat noch keine Eltern verknüpft."
            : `${ohneEltern} Kinder haben noch keine Eltern verknüpft.`,
        ),
      el(
        "div",
        { class: "werkzeuge" },
        el(
          "div",
          { class: "suche" },
          el("label", { class: "nur-leser", for: sucheId }, "Kinder suchen"),
          icon("lupe"),
          suche,
        ),
        filter?.wurzel,
      ),
      zaehler,
      wurzel,
      seiten.wurzel,
    ].filter(Boolean),
  );
}
