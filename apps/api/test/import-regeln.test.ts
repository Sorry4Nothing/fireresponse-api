import { describe, expect, test } from "vitest";
import {
  erzeugeBenutzername,
  normalisiereName,
  pruefeZeilen,
  type Bestand,
  type Zeile,
} from "../src/import-regeln.js";

const leer: Bestand = {
  kinder: new Set(),
  konten: new Set(),
  benutzernamen: new Set(),
};

describe("erzeugeBenutzername", () => {
  test.each([
    ["Vreni", "Muster", "vreni.muster"],
    ["Jürg", "Müller", "juerg.mueller"],
    ["Zoë", "Straße", "zoe.strasse"],
    ["José Maria", "O'Brien", "josemaria.obrien"],
    ["Hans-Peter", "von Arx", "hans-peter.vonarx"],
    ["  Ära ", "Öl", "aera.oel"],
  ])("%s %s wird %s", (vorname, nachname, erwartet) => {
    expect(erzeugeBenutzername(vorname, nachname, new Set())).toBe(erwartet);
  });

  test("ein belegter Name bekommt eine Nummer", () => {
    expect(
      erzeugeBenutzername("Vreni", "Muster", new Set(["vreni.muster"])),
    ).toBe("vreni.muster2");
  });

  test("Kollision wird mit 2, 3, … durchnummeriert", () => {
    const belegt = new Set(["vreni.muster", "vreni.muster2"]);
    expect(erzeugeBenutzername("Vreni", "Muster", belegt)).toBe(
      "vreni.muster3",
    );
  });

  test("hält Mindest- und Höchstlänge ein, auch mit Nummer", () => {
    expect(erzeugeBenutzername("李", "王", new Set())).toBe("leitung");
    expect(erzeugeBenutzername("a", "b", new Set()).length).toBeGreaterThan(1);
    const lang = erzeugeBenutzername("a".repeat(50), "b".repeat(50), new Set());
    expect(lang).toHaveLength(64);
    expect(
      erzeugeBenutzername("a".repeat(50), "b".repeat(50), new Set([lang])),
    ).toMatch(/^[a-z.]{63}2$/);
  });

  test("bleibt im erlaubten Alphabet", () => {
    expect(erzeugeBenutzername("Ça va!", "Dupont (Cévi)", new Set())).toMatch(
      /^[a-z0-9._-]{2,64}$/,
    );
  });
});

describe("normalisiereName", () => {
  test("ohne Gross-/Kleinschreibung, Akzente und überzählige Leerzeichen", () => {
    expect(normalisiereName("  JOSÉ   Maria ")).toBe("jose maria");
  });
});

describe("pruefeZeilen", () => {
  const zeile = (vorname: string, nachname: string, art: Zeile["art"]) => ({
    vorname,
    nachname,
    art,
  });

  test("neu, vorhanden, doppelt, ungültig, ausgelassen und die Summen", () => {
    const { plan, summe } = pruefeZeilen(
      [
        zeile("Vreni", "Muster", "kind"),
        zeile("vreni", " MUSTER ", "kind"),
        zeile("Hans", "Beispiel", "kind"),
        zeile("Anna", "Probe", "leitung"),
        zeile("Anna", "Probe", "stufenleitung"),
        zeile("", "Leer", "kind"),
        zeile("x".repeat(101), "Name", "kind"),
        zeile("Nina", "Weg", "auslassen"),
        zeile("Vreni", "Muster", "leitung"),
      ],
      {
        ...leer,
        kinder: new Set(["hans beispiel"]),
      },
    );
    expect(plan.map((p) => p.status)).toEqual([
      "neu",
      "doppelt",
      "vorhanden",
      "neu",
      "doppelt",
      "ungueltig",
      "ungueltig",
      "ausgelassen",
      "neu",
    ]);
    expect(plan[5].grund).toBeTruthy();
    expect(summe).toEqual({
      neu: 3,
      vorhanden: 1,
      doppelt: 2,
      ungueltig: 2,
      ausgelassen: 1,
      kinder: 1,
      leitende: 2,
    });
  });

  test("Konto vergleicht gegen Konten, Kind gegen Kinder", () => {
    const { plan } = pruefeZeilen(
      [zeile("Anna", "Probe", "leitung"), zeile("Anna", "Probe", "kind")],
      { ...leer, konten: new Set(["anna probe"]) },
    );
    expect(plan.map((p) => p.status)).toEqual(["vorhanden", "neu"]);
  });

  test("Benutzername nur für neue Leitende; Kollision mit Konto und Datei, stabil", () => {
    const zeilen = [
      zeile("Anna", "Probe", "leitung"),
      zeile("Anna", "Probe", "leitung"),
      zeile("An na", "Probe", "leitung"),
      zeile("Kai", "Kind", "kind"),
    ];
    const bestand = { ...leer, benutzernamen: new Set(["anna.probe"]) };
    const { plan } = pruefeZeilen(zeilen, bestand);
    expect(plan.map((p) => p.benutzername)).toEqual([
      "anna.probe2",
      undefined,
      "anna.probe3",
      undefined,
    ]);
    expect(pruefeZeilen(zeilen, bestand).plan).toEqual(plan);
  });
});
