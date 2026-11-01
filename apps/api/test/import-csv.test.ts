import { describe, expect, test } from "vitest";
// Reines Browser-Modul der Verwaltung ohne Typen; es hat keine Abhängigkeit auf DOM
// @ts-expect-error TS7016: kein Typ für die JavaScript-Datei
import * as csv from "../public/admin/csv.js";

describe("Trenner erkennen", () => {
  test.each([
    ["Vorname;Nachname;Rolle\nAnna;Muster;Kind", ";"],
    ["Vorname,Nachname,Rolle\nAnna,Muster,Kind", ","],
    ["Vorname\tNachname\tRolle\nAnna\tMuster\tKind", "\t"],
    ["Vorname\nAnna", ";"],
    // Trenner in Anführungszeichen zählen nicht
    ['"Name, Vorname";Rolle\n"Muster, Anna";Kind', ";"],
  ])("%j -> %j", (text, trenner) => {
    expect(csv.erkenneTrenner(text)).toBe(trenner);
  });
});

describe("CSV lesen", () => {
  test("Kopfzeile, Datenzeilen, BOM und CRLF", () => {
    const gelesen = csv.liesCsv(
      "﻿Vorname;Nachname\r\nAnna;Muster\r\nBen;Beispiel\r\n",
    );
    expect(gelesen.trenner).toBe(";");
    expect(gelesen.kopf).toEqual(["Vorname", "Nachname"]);
    expect(gelesen.zeilen).toEqual([
      ["Anna", "Muster"],
      ["Ben", "Beispiel"],
    ]);
  });

  test("Anführungszeichen, doppelte Anführungszeichen und Zeilenumbruch im Feld", () => {
    const zeilen = csv.parseCsv(
      'Name;Notiz\n"Muster, Anna";"sagt ""Hallo""\nund geht"\nBen;ohne',
      ";",
    );
    expect(zeilen).toEqual([
      ["Name", "Notiz"],
      ["Muster, Anna", 'sagt "Hallo"\nund geht'],
      ["Ben", "ohne"],
    ]);
  });

  test("leere Zeilen fallen weg, Felder werden getrimmt, letzte Zeile ohne Umbruch zählt", () => {
    expect(csv.parseCsv("a; b \n\n ; \n;;\nc;d", ";")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("Anführungszeichen mitten im Feld bleiben stehen", () => {
    expect(csv.parseCsv('Zoe "Zack" Muster;x', ";")).toEqual([
      ['Zoe "Zack" Muster', "x"],
    ]);
  });

  test("sep=-Zeile von Excel legt den Trenner fest", () => {
    const gelesen = csv.liesCsv("sep=,\nA;B,C\n1,2");
    expect(gelesen.trenner).toBe(",");
    expect(gelesen.kopf).toEqual(["A;B", "C"]);
  });

  test("leere Datei", () => {
    expect(csv.liesCsv("")).toEqual({ trenner: ";", kopf: [], zeilen: [] });
  });
});

describe("Spalten vorschlagen", () => {
  test("Kopfzeile ohne Gross-/Kleinschreibung und Akzente", () => {
    expect(
      csv.schlageSpaltenVor([
        "Rufname",
        "FAMILIENNAME",
        "Übername",
        "Funktion",
      ]),
    ).toEqual({ vorname: 0, nachname: 1, rolle: 3 });
    expect(
      csv.schlageSpaltenVor(["Vorname", "Name", "Spitzname", "Rollen"]),
    ).toEqual({ vorname: 0, nachname: 1, rolle: 3 });
    expect(
      csv.schlageSpaltenVor(["Pfadiname", "Nachname", "Vorname", "Typ"]),
    ).toEqual({ vorname: 2, nachname: 1, rolle: 3 });
  });

  test("unbekannte Spalten bleiben offen, keine Spalte wird doppelt vergeben", () => {
    expect(csv.schlageSpaltenVor(["Nummer", "Geburtstag"])).toEqual({
      vorname: -1,
      nachname: -1,
      rolle: -1,
    });
    const v = csv.schlageSpaltenVor(["Vorname", "Name"]);
    expect(v.vorname).not.toBe(v.nachname);
  });

  test("Kopf mit Zusatz wird über das enthaltene Wort erkannt", () => {
    expect(
      csv.schlageSpaltenVor(["Vorname (Pflicht)", "Nachname 1"]),
    ).toMatchObject({ vorname: 0, nachname: 1 });
  });
});

describe("Rollen", () => {
  test("mehrere Werte in einer Zelle trennen, Weibliche Formen bleiben ganz", () => {
    expect(csv.teileRollen("Kind, Leiter; Helfer | Gast")).toEqual([
      "Kind",
      "Leiter",
      "Helfer",
      "Gast",
    ]);
    // Ein «/» ohne Leerzeichen gehört zum Rollennamen
    expect(csv.teileRollen("Kind/Leiter")).toEqual(["Kind/Leiter"]);
    expect(csv.teileRollen("Teilnehmer/-in, Leiter/in")).toEqual([
      "Teilnehmer/-in",
      "Leiter/in",
    ]);
    expect(csv.teileRollen("")).toEqual([]);
  });

  test.each([
    ["Kind", "kind"],
    ["Teilnehmer/-in", "kind"],
    ["Teilnehmende", "kind"],
    ["Leiter", "leitung"],
    ["Leiter/-in Wolfsstufe", "leitung"],
    ["Leitung", "leitung"],
    ["Stufenleitung", "stufenleitung"],
    ["Stufenleiter/in", "stufenleitung"],
    ["Gruppenleiter/-in", "leitung"],
    ["Abteilungsleitung", "auslassen"],
    ["Abteilungsleiter/-in", "auslassen"],
    ["J+S-Lagerleitung", "auslassen"],
    ["Hausverantwortliche/-r", "auslassen"],
    ["Webmaster/-in", "auslassen"],
    ["Externe/-r Region Musterstadt", "auslassen"],
    ["Mitglied Verein Musterdorf", "auslassen"],
    ["Gast", "auslassen"],
    ["", "auslassen"],
  ])("Vorschlag für %j ist %s", (wert, art) => {
    expect(csv.schlageArtVor(wert)).toBe(art);
  });

  test("die stärkste Art gewinnt", () => {
    expect(csv.staerksteArt(["kind", "leitung"])).toBe("leitung");
    expect(csv.staerksteArt(["leitung", "stufenleitung", "kind"])).toBe(
      "stufenleitung",
    );
    expect(csv.staerksteArt(["auslassen", "kind"])).toBe("kind");
    expect(csv.staerksteArt(["auslassen"])).toBe("auslassen");
    expect(csv.staerksteArt([])).toBe("auslassen");
  });

  test("verschiedene Werte zählen Zeilen, leere Zellen sind ein eigener Wert", () => {
    const zeilen = [
      ["Anna", "Kind"],
      ["Ben", "kind, Leiter"],
      ["Cleo", ""],
      ["Dino", "Leiter"],
    ];
    expect(csv.verschiedeneRollen(zeilen, 1)).toEqual([
      { wert: "Kind", schluessel: "kind", anzahl: 2 },
      { wert: "Leiter", schluessel: "leiter", anzahl: 2 },
      { wert: "", schluessel: "", anzahl: 1 },
    ]);
  });
});

describe("Export einer Mitgliederdatenbank", () => {
  const EBENE = "JS Musterdorf";
  const kopf = [
    "Vorname",
    "Nachname",
    "Spitzname",
    "Firmenname",
    "Haupt-E-Mail",
    "Hauptebene",
    "Rollen",
    "Anrede Eltern",
    "Beruf/Klasse",
  ];
  const zelle = (...eintraege: string[]) => eintraege.join(", ");

  test("echte Kopfzeile wird ohne Zutun zugeordnet", () => {
    expect(csv.schlageSpaltenVor(kopf)).toEqual({
      vorname: 0,
      nachname: 1,
      rolle: 6,
    });
    expect(csv.findeEbene(kopf)).toBe(5);
    expect(csv.findeEbene(["Vorname", "Rollen"])).toBe(-1);
  });

  test("Rollenzelle: Untergruppe, Hauptebene und Klammerzusatz fallen weg", () => {
    const text = zelle(
      `Teilnehmer/-in ${EBENE} / M Beispiel`,
      `Stufenleiter/-in (Elternkontakt) ${EBENE} / M Beispiel`,
      `Hausverantwortliche/-r (Bahnwagen) ${EBENE} / Teams`,
      `Webmaster/-in (Branding & Print & Fotos) ${EBENE} / Teams`,
      `Abteilungsleiter/-in ${EBENE}`,
      `Externe/-r Region Musterstadt / J+S-Lagerleitung`,
    );
    expect(csv.teileRollen(text, EBENE)).toEqual([
      "Teilnehmer/-in",
      "Stufenleiter/-in",
      "Hausverantwortliche/-r",
      "Webmaster/-in",
      "Abteilungsleiter/-in",
      "Externe/-r Region Musterstadt",
    ]);
    // Ohne bekannte Hauptebene bleibt sie am Namen hängen
    expect(csv.teileRollen(`Teilnehmer/-in ${EBENE} / M Beispiel`)).toEqual([
      `Teilnehmer/-in ${EBENE}`,
    ]);
  });

  test("Rollen der Datei werden gezählt und vorgeschlagen", () => {
    const zeilen = [
      [
        "Anna",
        "Muster",
        "",
        "",
        "",
        EBENE,
        `Teilnehmer/-in ${EBENE} / M Beispiel`,
      ],
      [
        "Ben",
        "Beispiel",
        "",
        "",
        "",
        EBENE,
        `Teilnehmer/-in ${EBENE} / M Beispiel`,
      ],
      [
        "Cleo",
        "Probe",
        "",
        "",
        "",
        EBENE,
        zelle(
          `Gruppenleiter/-in ${EBENE} / M Beispiel`,
          `Hausverantwortliche/-r (Leitung) ${EBENE} / Teams`,
        ),
      ],
      [
        "Dino",
        "Test",
        "",
        "",
        "",
        EBENE,
        zelle(
          `Stufenleiter/-in (Umwelt) ${EBENE} / M Beispiel`,
          `Gruppenleiter/-in ${EBENE} / M Beispiel`,
          `Webmaster/-in (Print) ${EBENE} / Teams`,
        ),
      ],
    ];
    const werte = csv.verschiedeneRollen(zeilen, 6, 5);
    expect(
      werte.map((w: { wert: string; anzahl: number }) => [w.wert, w.anzahl]),
    ).toEqual([
      ["Teilnehmer/-in", 2],
      ["Gruppenleiter/-in", 2],
      ["Hausverantwortliche/-r", 1],
      ["Stufenleiter/-in", 1],
      ["Webmaster/-in", 1],
    ]);
    const arten = new Map(
      werte.map((w: { wert: string; schluessel: string }) => [
        w.schluessel,
        csv.schlageArtVor(w.wert),
      ]),
    );
    const spalten = csv.schlageSpaltenVor(kopf);
    expect(
      csv
        .baueZeilen(zeilen, spalten, { arten, einheit: "kind", ebene: 5 })
        .map((z: { art: string }) => z.art),
    ).toEqual(["kind", "kind", "leitung", "stufenleitung"]);
  });
});

describe("Zeichensatz", () => {
  test("UTF-8 bleibt UTF-8", () => {
    const bytes = new TextEncoder().encode("Vorname;Nachname\nZoë;Müller");
    expect(csv.dekodiere(bytes)).toBe("Vorname;Nachname\nZoë;Müller");
  });

  test("Windows-1252 (Latin-1-Bytes) wird als Fallback gelesen", () => {
    // é = E9, ü = FC, ä = E4, ö = F6 in Windows-1252; als UTF-8 ungültig
    const bytes = Uint8Array.from(
      [..."Vorname;Nachname\nZo\xE9;M\xFCller;B\xE4r;K\xF6nig"].map((z) =>
        z.charCodeAt(0),
      ),
    );
    expect(csv.dekodiere(bytes)).toBe("Vorname;Nachname\nZoé;Müller;Bär;König");
  });
});

describe("Zeilen für die API", () => {
  const zeilen = [
    ["Anna", "Muster", "Fuchs", "Kind"],
    ["Ben", "Beispiel", "", "Kind, Leiter"],
    ["Cleo", "Probe", "", "Gast"],
    ["Dino", "Test", "", ""],
  ];
  const spalten = { vorname: 0, nachname: 1, rolle: 3 };

  test("Art nach Zuordnung, stärkste gewinnt", () => {
    const arten = new Map([
      ["kind", "kind"],
      ["leiter", "leitung"],
      ["gast", "auslassen"],
    ]);
    expect(csv.baueZeilen(zeilen, spalten, { arten, einheit: "kind" })).toEqual(
      [
        { vorname: "Anna", nachname: "Muster", art: "kind" },
        { vorname: "Ben", nachname: "Beispiel", art: "leitung" },
        { vorname: "Cleo", nachname: "Probe", art: "auslassen" },
        { vorname: "Dino", nachname: "Test", art: "auslassen" },
      ],
    );
  });

  test("ohne Rollenspalte gilt die Art für alle", () => {
    const ohne = { vorname: 0, nachname: 1, rolle: -1 };
    const ergebnis = csv.baueZeilen(zeilen, ohne, {
      arten: new Map(),
      einheit: "leitung",
    });
    expect(ergebnis.map((z: { art: string }) => z.art)).toEqual([
      "leitung",
      "leitung",
      "leitung",
      "leitung",
    ]);
  });

  test("kurze Zeilen ergeben leere Felder statt eines Fehlers", () => {
    expect(
      csv.baueZeilen([["Eva"]], spalten, {
        arten: new Map(),
        einheit: "kind",
      }),
    ).toEqual([{ vorname: "Eva", nachname: "", art: "auslassen" }]);
  });
});

describe("CSV schreiben", () => {
  test("Felder mit Trenner, Anführungszeichen oder Umbruch werden eingefasst", () => {
    expect(
      csv.schreibeCsv([
        ["Name", "Passwort"],
        ["Muster; Anna", 'a"b'],
      ]),
    ).toBe('Name;Passwort\r\n"Muster; Anna";"a""b"\r\n');
  });

  test("Rundreise: was geschrieben wird, liest sich gleich zurück", () => {
    const zeilen = [
      ["Name", "Passwort"],
      ["Anna; Muster", 'x"y'],
      ["Ben\nBeispiel", "z"],
    ];
    expect(csv.liesCsv(csv.schreibeCsv(zeilen))).toEqual({
      trenner: ";",
      kopf: zeilen[0],
      zeilen: zeilen.slice(1),
    });
  });

  test("Formelzeichen am Anfang werden entschärft", () => {
    expect(csv.entschaerfe("=1+1")).toBe("'=1+1");
    expect(csv.entschaerfe("@summe")).toBe("'@summe");
    expect(csv.entschaerfe("Anna")).toBe("Anna");
  });
});

describe("Schnellweg ohne Zuordnung", () => {
  const kopf = ["Vorname", "Nachname", "Spitzname", "Hauptebene", "Rollen"];
  const zeile = (rolle: string) => [
    "Anna",
    "Muster",
    "Fuchs",
    "JS Musterdorf",
    rolle,
  ];

  test("ja: Namen und Rollenspalte erkannt, eine Rolle passt", () => {
    const zeilen = [
      zeile("Teilnehmer/-in JS Musterdorf / Wolfsstufe"),
      zeile("Webmaster/-in JS Musterdorf / Teams"),
    ];
    expect(csv.kannSchnellweg(kopf, zeilen)).toBe(true);
  });

  test("nein: keine Rollenspalte, die Art ist nicht entscheidbar", () => {
    expect(
      csv.kannSchnellweg(["Vorname", "Nachname"], [["Anna", "Muster"]]),
    ).toBe(false);
  });

  test("nein: Vor- oder Nachname fehlt", () => {
    expect(
      csv.kannSchnellweg(["Vorname", "Rollen"], [["Anna", "Teilnehmer/-in"]]),
    ).toBe(false);
    expect(
      csv.kannSchnellweg(
        ["Spalte A", "Spalte B", "Rollen"],
        [["a", "b", "Kind"]],
      ),
    ).toBe(false);
  });

  test("nein: keine einzige Rolle passt zu Kind, Leitung oder Stufenleitung", () => {
    const zeilen = [
      zeile("Webmaster/-in JS Musterdorf / Teams"),
      zeile("Externe/-r Region / Lagerleitung"),
    ];
    expect(csv.kannSchnellweg(kopf, zeilen)).toBe(false);
  });
});
