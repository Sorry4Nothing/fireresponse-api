import { auswahl, el } from "./dom.js";

// Abzeichen der Ränge: 0 bis 2 Sterne oder ein eigenes Bild (SVG oder PNG), dazu die Auswahl eines Rangs. Die Ränge sind fest und werden nur im Backend gepflegt; die Verwaltung zeigt sie in Personen und Teilnehmenden.

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
  el("span", { class: "rang-zelle" }, abzeichenOderGrund(rang, "k"), rang.name);

// Ränge eines Typs, der tiefste zuerst: Leitende tragen «miliz» (Nr. 10 ist der höchste Dienstgrad), die Teilnehmenden den Typ ihrer Einheit («kf» oder «jf», Nr. 10 ist der tiefste)
export const raengeVomTyp = (raenge, typ) =>
  raenge
    .filter((r) => r.typ === typ)
    .sort((a, b) =>
      typ === "miliz"
        ? b.reihenfolge - a.reihenfolge
        : a.reihenfolge - b.reihenfolge,
    );

// Das Abzeichen des Rangs; ohne Abzeichen der schwarze Grund
const abzeichenOderGrund = (rang, groesse) =>
  abzeichen(rang, groesse) ??
  svg(
    "svg",
    {
      class: `rb rb--${groesse}`,
      viewBox: "0 0 100 130",
      "aria-hidden": "true",
    },
    abzeichenGrund(),
  );

// Leerer Platz in Abzeichen-Grösse, damit «Kein Rang» auf einer Linie mit den übrigen steht
const platzhalter = () => el("span", { class: "rb rb--k" });

// Auswahl für ein Feld «Rang»: «Kein Rang» und alle Ränge der Einheit
export function raengeAuswahl(raenge, wert, label = "Rang") {
  return auswahl({
    label,
    optionen: [
      ["", "Kein Rang", platzhalter()],
      ...raenge.map((r) => [r.id, r.name, abzeichenOderGrund(r, "k")]),
    ],
    wert,
  });
}
