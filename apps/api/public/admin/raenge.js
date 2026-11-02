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

// Ränge einer Einheit mit Abzeichen: 0 bis 2 Sterne oder ein eigenes Bild (SVG oder PNG). Die Prüfung und die Bereinigung des Bildes macht der Server; hier steht nur eine Vorprüfung, damit niemand 500 KB umsonst schickt.

const BILD_MAX = 500 * 1024;

export const RANGTYP = {
  kf: "Kinderfeuerwehr",
  jf: "Jugendfeuerwehr",
  miliz: "Miliz-Feuerwehr",
};

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

// Schwarzer Grund im Verhältnis 7:13 wie bei den Miliz-Abzeichen (60,5 × 112,4 von 100 × 130, senkrecht zentriert): ganz allein das Abzeichen des Rangs ohne Sterne und Text
function abzeichenGrund() {
  return svg("rect", {
    x: 19.75,
    y: 8.8,
    width: 60.5,
    height: 112.4,
    fill: "#000",
  });
}

// Das Abzeichen der Vorlage mit n Sternen (Hochformat 100:130, schmal wie die Miliz-Abzeichen); Zierde, der Text steht daneben
function sterneAbzeichen(n) {
  // Grösste Sterne, die noch in die schwarze Fläche passen (Breite ca. 56 im Inhalt); mehr als 2 gibt es neu nicht, ältere Ränge schrumpfen mit
  const abstand = Math.min(24, 56 / n);
  const radius = Math.min(10, abstand * 0.45);
  const mitte = 50 - ((n - 1) * abstand) / 2;
  // Inhalt um die Mitte (50,65) auf 95 % verkleinert, damit er in die kürzere schwarze Fläche passt
  return [
    abzeichenGrund(),
    svg(
      "g",
      { transform: "translate(2.5,3.25) scale(0.95)" },
      svg(
        "g",
        {
          "font-family": "'Barlow Condensed','Arial Narrow',Arial,sans-serif",
          "font-weight": 700,
          fill: "#E8B22E",
          "text-anchor": "middle",
          "font-size": 11,
        },
        svg(
          "text",
          {
            x: 50,
            y: 22,
            textLength: 50,
            lengthAdjust: "spacingAndGlyphs",
          },
          "JUGEND",
        ),
        svg(
          "text",
          {
            x: 50,
            y: 37,
            textLength: 50,
            lengthAdjust: "spacingAndGlyphs",
          },
          "FEUERWEHR",
        ),
      ),
      svg(
        "g",
        { transform: "translate(29.8,48) scale(0.17)" },
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
      ...Array.from({ length: n }, (_, i) =>
        stern(mitte + i * abstand, radius),
      ),
    ),
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

// Name des Rangs mit seinem Abzeichen davor; rang ist ein Rang der API mit name und abzeichen
export const rangZelle = (rang) =>
  el("span", { class: "rang-zelle" }, abzeichen(rang, "k"), rang.name);

// Miliz-Ränge gehören den Leitenden; für Teilnehmende gibt die API sie nicht frei
export const ohneMiliz = (raenge) => raenge.filter((r) => r.typ !== "miliz");

// Leitende tragen nur Miliz-Ränge
export const nurMiliz = (raenge) => raenge.filter((r) => r.typ === "miliz");

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

// Ränge werden nur im Backend angelegt; das Seitenblatt bearbeitet einen bestehenden Rang
function blatt(rang, einheit, raenge, ctx, neu) {
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
  const rangTyp = { wert: rang.typ };
  const typGruppe = neueId("rang-typ");
  const typOptionen = Object.entries(RANGTYP).flatMap(([wert, text]) => {
    const id = neueId("rang-typ-option");
    return [
      el("input", {
        type: "radio",
        id,
        name: typGruppe,
        value: wert,
        checked: wert === rangTyp.wert,
        onchange: () => {
          rangTyp.wert = wert;
        },
      }),
      el("label", { for: id }, icon("haken"), text),
    ];
  });
  const reihenfolge = feld({
    label: "Reihenfolge",
    typ: "number",
    wert: String(rang.reihenfolge),
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
    max: 2,
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
      const n = Math.max(0, Math.min(2, Number(sterne.eingabe.value) || 0));
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
    el(
      "div",
      { class: "seg", role: "radiogroup", "aria-label": "Typ des Rangs" },
      typOptionen,
    ),
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
              : `${mehrzahl(verwendet, "Person hat", "Personen haben")} diesen Rang. Sie können erst wechseln, wenn die Einheit einen weiteren Rang hat.`,
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
    titel: rang.name,
    untertitel: mehrzahl(verwendet, "Person", "Personen") + " mit diesem Rang",
    inhalt: [formular, loeschen],
    fusszeile: [
      knopf("Abbrechen", { onclick: () => dialog.close() }),
      el(
        "button",
        { type: "submit", form: formularId, class: "knopf knopf--haupt" },
        "Speichern",
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
        Number(sterne.eingabe.value) <= 2
      )
    ) {
      fehler.textContent = "Die Anzahl der Sterne ist eine Zahl von 0 bis 2.";
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
      typ: rangTyp.wert,
      reihenfolge: n,
    };
    if (art.wert === "sterne") {
      felder.abzeichenSterne = Number(sterne.eingabe.value);
    }
    const bild = art.wert === "bild" ? datei.files?.[0] : undefined;
    const id = rang.id;
    try {
      await anfrage("PATCH", url(einheit, `/${id}`), felder);
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
        fehler.textContent = `Die Angaben sind gespeichert, aber das Bild wurde abgelehnt: ${fehlertext(f)}`;
        fehler.hidden = false;
        fehler.focus();
        return;
      }
    }
    zustand.fokus = id;
    dialog.close();
    neu();
    ctx.melde("Gespeichert.");
  });
}

function zeichne(bereich, ctx, einheit, raenge, neu) {
  if (raenge.length === 0) {
    bereich.append(
      el("p", { class: "leer" }, "Diese Einheit hat noch keine Ränge."),
    );
    return;
  }
  const verschiebe = async (rang, richtung) => {
    const ids = raenge.filter((r) => r.typ === rang.typ).map((r) => r.id);
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
  const karte = (r, gruppe, i) => {
    const n = r.teilnehmende + r.rollen;
    return el(
      "li",
      { class: "karte rang-karte", "data-fokus": r.id },
      abzeichen(r, "g") ??
        svg(
          "svg",
          {
            class: "rb rb--g",
            viewBox: "0 0 100 130",
            "aria-hidden": "true",
          },
          abzeichenGrund(),
        ),
      el(
        "div",
        { class: "rang-text" },
        el("h3", {}, r.name),
        el(
          "ul",
          { class: "chips" },
          chip(RANGTYP[r.typ], "stufe"),
          chip(`Kürzel ${r.kuerzel}`),
          chip(`Nr. ${r.reihenfolge}`),
          chip(mehrzahl(n, "Person", "Personen")),
          r.abzeichen?.art === "sterne" &&
            chip(SCHRIFT_ABZEICHEN.sterne(r.abzeichen.sterne)),
          r.abzeichen?.art === "bild" && chip("Eigenes Bild"),
          !r.abzeichen && chip("Kein Abzeichen"),
        ),
      ),
      r.typ === "miliz"
        ? null
        : el(
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
              disabled: i === gruppe.length - 1,
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
  };
  // Jeder Typ hat seine eigene Hierarchie: eine Liste je Typ
  const listen = Object.entries(RANGTYP).flatMap(([typ, text]) => {
    const gruppe = raenge.filter((r) => r.typ === typ);
    if (gruppe.length === 0) return [];
    return [
      el("h2", { class: "abschnitt" }, text),
      el(
        "ul",
        { class: "rang-liste", "aria-label": `Ränge ${text}` },
        gruppe.map((r, i) => karte(r, gruppe, i)),
      ),
    ];
  });
  bereich.append(
    el(
      "p",
      { class: "klein leise", role: "status" },
      `${mehrzahl(raenge.length, "Rang", "Ränge")} · jeder Typ hat seine eigene Reihenfolge, von oben nach unten`,
    ),
    ...listen,
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
