import { anfrage, fehlertext } from "./api.js";
import {
  auswahl,
  chip,
  el,
  feld,
  icon,
  knopf,
  neueId,
  seitenblatt,
} from "./dom.js";
import { mehrzahl } from "./konten.js";

// Ränge einer Einheit mit Abzeichen: 0 bis 5 Sterne oder ein eigenes Bild (SVG oder PNG). Die Prüfung und die Bereinigung des Bildes macht der Server; hier steht nur eine Vorprüfung, damit niemand 500 KB umsonst schickt.

const BILD_MAX = 500 * 1024;
const SVG_NS = "http://www.w3.org/2000/svg";

const svg = (tag, eigenschaften = {}, ...kinder) => {
  const knoten = document.createElementNS(SVG_NS, tag);
  for (const [name, wert] of Object.entries(eigenschaften)) {
    knoten.setAttribute(name, String(wert));
  }
  knoten.append(...kinder);
  return knoten;
};

// Ein Stern mit fünf Spitzen um (x, 114)
function stern(x, radius) {
  const punkte = Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 === 0 ? radius : radius * 0.42;
    const winkel = (Math.PI / 5) * i - Math.PI / 2;
    return `${(x + r * Math.cos(winkel)).toFixed(2)},${(114 + r * Math.sin(winkel)).toFixed(2)}`;
  });
  return svg("polygon", {
    points: punkte.join(" "),
    fill: "#E8B22E",
    stroke: "#B88414",
    "stroke-width": 0.6,
    "stroke-linejoin": "round",
  });
}

// Das Abzeichen der Vorlage mit n Sternen (Hochformat 100:130); Zierde, der Text steht daneben
function sterneAbzeichen(n) {
  const radius = n === 5 ? 7 : 8;
  const abstand = n === 5 ? 20 : n === 4 ? 24 : n === 3 ? 30 : 34;
  const mitte = 50 - ((n - 1) * abstand) / 2;
  return [
    svg("rect", {
      x: 1,
      y: 1,
      width: 98,
      height: 128,
      rx: 3,
      fill: "#0A1230",
      stroke: "#1B2A5C",
      "stroke-width": 2,
    }),
    svg(
      "g",
      {
        "font-family": "'Barlow Condensed','Arial Narrow',Arial,sans-serif",
        "font-weight": 700,
        fill: "#E8B22E",
        "text-anchor": "middle",
        "font-size": 17,
      },
      svg(
        "text",
        {
          x: 50,
          y: 25,
          textLength: 78,
          lengthAdjust: "spacingAndGlyphs",
        },
        "JUGEND",
      ),
      svg(
        "text",
        {
          x: 50,
          y: 44,
          textLength: 78,
          lengthAdjust: "spacingAndGlyphs",
        },
        "FEUERWEHR",
      ),
    ),
    svg(
      "g",
      { transform: "translate(26,50) scale(0.2,0.1925)" },
      svg("path", {
        d: "m 1,1 4.325489,181.67978 c 3.089633,129.77118 226.161731,129.77118 229.251371,0 L 238.90236,1 Z",
        fill: "#FFFFFF",
      }),
      svg("path", {
        d: "m 1,0.98764 4.3125,181.6875 C 7.9334996,292.76272 168.85432,309.46046 219.5,232.76889 Z",
        fill: "#2764C7",
      }),
      svg("path", {
        d: "m 1,1 4.325489,181.67978 c 3.089633,129.77118 226.161731,129.77118 229.251371,0 L 238.90236,1 Z",
        fill: "none",
        stroke: "#DDE9FA",
        "stroke-width": 6,
      }),
    ),
    ...Array.from({ length: n }, (_, i) => stern(mitte + i * abstand, radius)),
  ];
}

export const SCHRIFT_ABZEICHEN = {
  sterne: (n) =>
    n === 1 ? "1 Stern" : n === 0 ? "keine Sterne" : `${n} Sterne`,
};

// Das Abzeichen eines Rangs als Bild: Sterne gezeichnet, ein eigenes Bild über seine Adresse. groesse: "k" (Chip), "m", "g", "x"
export function abzeichen(rang, groesse = "m") {
  const a = rang?.abzeichen;
  if (!a) return null;
  if (a.art === "bild") {
    return el("img", {
      class: `rb rb--${groesse}`,
      src: a.url,
      alt: `Abzeichen ${rang.name}`,
    });
  }
  const knoten = svg(
    "svg",
    {
      class: `rb rb--${groesse}`,
      viewBox: "0 0 100 130",
      role: "img",
      "aria-label": `Abzeichen ${rang.name}, ${SCHRIFT_ABZEICHEN.sterne(a.sterne)}`,
    },
    ...sterneAbzeichen(a.sterne),
  );
  return knoten;
}

// Auswahl für ein Feld «Rang»: «Kein Rang» und alle Ränge der Einheit
export function raengeAuswahl(raenge, wert, label = "Rang") {
  return auswahl({
    label,
    optionen: [["", "Kein Rang"], ...raenge.map((r) => [r.id, r.name])],
    wert,
  });
}

const url = (einheit, rest = "") =>
  `/api/v1/admin/einheiten/${einheit.id}/raenge${rest}`;

const zustand = { fokus: null };

export function zeige(bereich, ctx) {
  zustand.fokus = null;
  const einheit = ctx.einheit;
  ctx.lade(
    () => anfrage("GET", url(einheit)),
    (daten, neu) => zeichne(bereich, ctx, einheit, daten.raenge, neu),
  );
}

// Anlegen und Bearbeiten im selben Seitenblatt; rang ist leer beim Anlegen
function blatt(rang, einheit, raenge, ctx, neu) {
  const neuAnlegen = !rang;
  const name = feld({
    label: "Name",
    wert: rang?.name ?? "",
    maxlength: 100,
    required: true,
  });
  const kuerzel = feld({
    label: "Kürzel",
    wert: rang?.kuerzel ?? "",
    maxlength: 20,
    required: true,
  });
  const hoechste = raenge.reduce((m, r) => Math.max(m, r.reihenfolge), 0);
  const reihenfolge = feld({
    label: "Reihenfolge",
    typ: "number",
    wert: String(rang?.reihenfolge ?? Math.min(999, hoechste + 10)),
    min: 1,
    max: 999,
    inputmode: "numeric",
    required: true,
    hilfe:
      "Eine ganze Zahl von 1 bis 999. Tipp: in Zehnerschritten, dann passt später ein Rang dazwischen. Mit den Pfeilen in der Liste änderst du sie auch.",
  });

  // Art des Abzeichens: Sterne oder eigenes Bild
  const art = { wert: rang?.abzeichen?.art ?? "sterne" };
  const sterne = feld({
    label: "Anzahl Sterne",
    typ: "number",
    wert: String(rang?.abzeichen?.sterne ?? 0),
    min: 0,
    max: 5,
    inputmode: "numeric",
  });
  const dateiId = neueId("abzeichen-datei");
  const datei = el("input", {
    id: dateiId,
    type: "file",
    accept: "image/svg+xml,image/png,.svg,.png",
  });
  const dateiFeld = el(
    "div",
    { class: "feld" },
    el("label", { for: dateiId }, "Bild (SVG oder PNG)"),
    datei,
    el(
      "p",
      { class: "hilfe" },
      "Hochformat im Verhältnis 100:130, bei PNG mindestens 200 × 260 Pixel, höchstens 500 KB. Der Server prüft die Datei und bereinigt ein SVG.",
    ),
  );
  const dateiFehler = el("p", {
    class: "hinweis hinweis--fehler",
    role: "alert",
    hidden: true,
  });
  const vorschau = el("div", { class: "abzeichen-vorschau" });
  const zeigeVorschau = () => {
    if (art.wert === "sterne") {
      const n = Math.max(0, Math.min(5, Number(sterne.eingabe.value) || 0));
      vorschau.replaceChildren(
        abzeichen(
          { name: "Vorschau", abzeichen: { art: "sterne", sterne: n } },
          "x",
        ),
      );
    } else if (rang?.abzeichen?.art === "bild" && !datei.files?.length) {
      vorschau.replaceChildren(abzeichen(rang, "x"));
    } else {
      vorschau.replaceChildren(
        el("p", { class: "leise klein" }, "Noch kein Bild gewählt."),
      );
    }
  };
  const gruppeName = neueId("art");
  const optionen = [
    ["sterne", "Sterne"],
    ["bild", "Eigenes Bild"],
  ].map(([wert, text]) => {
    const id = neueId("art-option");
    return [
      el("input", {
        type: "radio",
        id,
        name: gruppeName,
        value: wert,
        checked: wert === art.wert,
        onchange: () => {
          art.wert = wert;
          umschalten();
        },
      }),
      el("label", { for: id }, icon("haken"), text),
    ];
  });
  const umschalten = () => {
    sterne.wurzel.hidden = art.wert !== "sterne";
    dateiFeld.hidden = art.wert !== "bild";
    zeigeVorschau();
  };
  sterne.eingabe.addEventListener("input", zeigeVorschau);
  datei.addEventListener("change", () => {
    dateiFehler.hidden = true;
    const gewaehlt = datei.files?.[0];
    if (gewaehlt && gewaehlt.size > BILD_MAX) {
      dateiFehler.textContent = "Die Datei ist grösser als 500 KB.";
      dateiFehler.hidden = false;
      datei.value = "";
    }
    zeigeVorschau();
  });
  umschalten();

  const fehler = el("p", {
    class: "hinweis hinweis--fehler",
    role: "alert",
    hidden: true,
    tabindex: "-1",
  });
  const formularId = neueId("rang-formular");
  const formular = el(
    "form",
    {
      class: "formular",
      id: formularId,
      novalidate: true,
      onsubmit: (e) => e.preventDefault(),
    },
    el("h3", {}, "Angaben"),
    name.wurzel,
    el("div", { class: "zweispaltig" }, kuerzel.wurzel, reihenfolge.wurzel),
    el("h3", {}, "Abzeichen"),
    el(
      "div",
      { class: "abzeichen-zeile" },
      vorschau,
      el(
        "div",
        { class: "formular" },
        el(
          "div",
          {
            class: "seg",
            role: "radiogroup",
            "aria-label": "Art des Abzeichens",
          },
          optionen.flat(),
        ),
        sterne.wurzel,
        dateiFeld,
        dateiFehler,
      ),
    ),
    fehler,
  );

  // Löschen: ohne zugeteilte Personen sofort, sonst mit dem Rang, in den sie wechseln
  const verwendet = rang ? rang.teilnehmende + rang.rollen : 0;
  const andere = rang ? raenge.filter((r) => r.id !== rang.id) : [];
  let loeschen = null;
  if (rang) {
    const ziel =
      verwendet > 0 && andere.length > 0
        ? auswahl({
            label: "Personen verschieben nach",
            optionen: andere.map((r) => [r.id, r.name]),
            wert: andere[0].id,
          })
        : null;
    loeschen = el(
      "div",
      { class: "abschnitt" },
      el("h3", {}, "Rang löschen"),
      verwendet > 0 &&
        el(
          "div",
          { class: "hinweis hinweis--warn" },
          el(
            "span",
            {},
            andere.length > 0
              ? `${mehrzahl(verwendet, "Person hat", "Personen haben")} diesen Rang. Sie wechseln beim Löschen in den gewählten Rang.`
              : `${mehrzahl(verwendet, "Person hat", "Personen haben")} diesen Rang. Lege zuerst einen anderen Rang an, damit sie dorthin wechseln können.`,
          ),
        ),
      ziel?.wurzel,
      (verwendet === 0 || andere.length > 0) &&
        knopf("Rang löschen", {
          art: "gefahr",
          symbol: "papierkorb",
          onclick: async () => {
            try {
              await anfrage(
                "DELETE",
                url(einheit, `/${rang.id}`) +
                  (ziel ? `?verschiebenNach=${ziel.eingabe.value}` : ""),
              );
            } catch (f) {
              fehler.textContent = fehlertext(f);
              fehler.hidden = false;
              fehler.focus();
              return;
            }
            dialog.close();
            neu();
            ctx.melde(`Rang «${rang.name}» ist gelöscht.`);
          },
        }),
    );
  }

  const dialog = seitenblatt({
    titel: neuAnlegen ? "Rang anlegen" : rang.name,
    untertitel: neuAnlegen
      ? "Die Ränge gelten nur für diese Einheit."
      : mehrzahl(verwendet, "Person", "Personen") + " mit diesem Rang",
    inhalt: [formular, loeschen],
    fusszeile: [
      knopf("Abbrechen", { onclick: () => dialog.close() }),
      el(
        "button",
        { type: "submit", form: formularId, class: "knopf knopf--haupt" },
        neuAnlegen ? "Anlegen" : "Speichern",
      ),
    ],
  });
  formular.addEventListener("submit", async () => {
    fehler.hidden = true;
    fehler.textContent = "";
    const n = Number(reihenfolge.eingabe.value);
    if (!name.eingabe.value.trim() || !kuerzel.eingabe.value.trim()) {
      fehler.textContent = "Bitte Name und Kürzel ausfüllen.";
    } else if (!Number.isInteger(n) || n < 1 || n > 999) {
      fehler.textContent = "Die Reihenfolge ist eine ganze Zahl von 1 bis 999.";
    } else if (
      art.wert === "sterne" &&
      !(
        Number.isInteger(Number(sterne.eingabe.value)) &&
        Number(sterne.eingabe.value) >= 0 &&
        Number(sterne.eingabe.value) <= 5
      )
    ) {
      fehler.textContent = "Die Anzahl der Sterne ist eine Zahl von 0 bis 5.";
    } else if (
      art.wert === "bild" &&
      !datei.files?.length &&
      rang?.abzeichen?.art !== "bild"
    ) {
      fehler.textContent = "Bitte ein Bild wählen.";
    }
    if (fehler.textContent && fehler.hidden) {
      fehler.hidden = false;
      fehler.focus();
      return;
    }
    const felder = {
      name: name.eingabe.value.trim(),
      kuerzel: kuerzel.eingabe.value.trim(),
      reihenfolge: n,
    };
    if (art.wert === "sterne") {
      felder.abzeichenSterne = Number(sterne.eingabe.value);
    }
    const bild = art.wert === "bild" ? datei.files?.[0] : undefined;
    let id = rang?.id;
    try {
      if (neuAnlegen) {
        ({ id } = await anfrage("POST", url(einheit), felder));
      } else {
        await anfrage("PATCH", url(einheit, `/${rang.id}`), felder);
      }
    } catch (f) {
      fehler.textContent = fehlertext(f);
      fehler.hidden = false;
      fehler.focus();
      return;
    }
    if (bild) {
      try {
        await anfrage("PUT", url(einheit, `/${id}/abzeichen`), bild);
      } catch (f) {
        // Der Rang steht schon: Das Blatt bleibt offen, und die Meldung nennt den Grund
        neu();
        fehler.textContent = `${neuAnlegen ? "Der Rang ist angelegt, aber das" : "Die Angaben sind gespeichert, aber das"} Bild wurde abgelehnt: ${fehlertext(f)}`;
        fehler.hidden = false;
        fehler.focus();
        return;
      }
    }
    zustand.fokus = id;
    dialog.close();
    neu();
    ctx.melde(neuAnlegen ? "Rang ist angelegt." : "Gespeichert.");
  });
}

function zeichne(bereich, ctx, einheit, raenge, neu) {
  ctx.kopfAktion(
    knopf("Rang anlegen", {
      art: "haupt",
      symbol: "plus",
      onclick: () => blatt(null, einheit, raenge, ctx, neu),
    }),
  );
  if (raenge.length === 0) {
    bereich.append(
      el(
        "p",
        { class: "leer" },
        "Diese Einheit hat noch keine Ränge. Lege einen an, dann lassen sich Personen einem Rang zuteilen.",
      ),
    );
    return;
  }
  const verschiebe = async (rang, richtung) => {
    const ids = raenge.map((r) => r.id);
    const i = ids.indexOf(rang.id);
    ids.splice(i, 1);
    ids.splice(i + richtung, 0, rang.id);
    try {
      await anfrage("PUT", url(einheit, "/reihenfolge"), { ids });
    } catch {
      ctx.melde("Die Reihenfolge lässt sich nicht ändern.", "fehler");
      return;
    }
    zustand.fokus = `${rang.id}:${richtung < 0 ? "hoch" : "runter"}`;
    neu();
    ctx.melde(`«${rang.name}» steht jetzt an Position ${i + richtung + 1}.`);
  };
  const liste = el(
    "ul",
    { class: "rang-liste", "aria-label": "Ränge" },
    raenge.map((r, i) => {
      const n = r.teilnehmende + r.rollen;
      return el(
        "li",
        { class: "karte rang-karte", "data-fokus": r.id },
        abzeichen(r, "g") ?? el("span", { class: "rb rb--g rb--leer" }, "–"),
        el(
          "div",
          { class: "rang-text" },
          el("h3", {}, r.name),
          el(
            "ul",
            { class: "chips" },
            chip(`Kürzel ${r.kuerzel}`, "stufe"),
            chip(`Nr. ${r.reihenfolge}`),
            chip(mehrzahl(n, "Person", "Personen")),
            r.abzeichen?.art === "sterne" &&
              chip(SCHRIFT_ABZEICHEN.sterne(r.abzeichen.sterne)),
            r.abzeichen?.art === "bild" && chip("Eigenes Bild"),
            !r.abzeichen && chip("Kein Abzeichen"),
          ),
        ),
        el(
          "div",
          { class: "aktionen" },
          knopf("", {
            art: "rund",
            symbol: "hoch",
            "aria-label": `${r.name} nach oben`,
            disabled: i === 0,
            "data-fokus": `${r.id}:hoch`,
            onclick: () => verschiebe(r, -1),
          }),
          knopf("", {
            art: "rund",
            symbol: "runter",
            "aria-label": `${r.name} nach unten`,
            disabled: i === raenge.length - 1,
            "data-fokus": `${r.id}:runter`,
            onclick: () => verschiebe(r, 1),
          }),
          knopf("Bearbeiten", {
            klein: true,
            symbol: "bearbeiten",
            kontext: r.name,
            onclick: () => blatt(r, einheit, raenge, ctx, neu),
          }),
        ),
      );
    }),
  );
  bereich.append(
    el(
      "p",
      { class: "klein leise", role: "status" },
      `${mehrzahl(raenge.length, "Rang", "Ränge")} · die Reihenfolge von oben nach unten gilt in Verwaltung und App`,
    ),
    liste,
  );
  if (zustand.fokus) {
    const [id, richtung] = zustand.fokus.split(":");
    let ziel;
    if (richtung) {
      // Ein Pfeil, der am Rand gesperrt ist, gibt den Fokus an den Gegenpfeil
      ziel = bereich.querySelector(`[data-fokus="${id}:${richtung}"]`);
      if (ziel?.disabled) {
        ziel = bereich.querySelector(
          `[data-fokus="${id}:${richtung === "hoch" ? "runter" : "hoch"}"]`,
        );
      }
    } else {
      ziel = [
        ...(bereich
          .querySelector(`li[data-fokus="${id}"]`)
          ?.querySelectorAll("button") ?? []),
      ].at(-1);
    }
    ziel?.focus();
    zustand.fokus = null;
  }
}
