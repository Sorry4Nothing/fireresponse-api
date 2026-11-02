import { describe, expect, test } from "vitest";
import { leseLodurSeite, SeitenFehler } from "../src/lodur-html.js";
import { ECHTE_ZEILEN, lodurSeite, type Zeile } from "./hilfen/lodur-seite.js";

const lies = (zeilen: Zeile[]) => leseLodurSeite(lodurSeite(zeilen));

describe("leseLodurSeite", () => {
  test("liest eine Zeile: Zeit in Schweizer Ortszeit als UTC, Art, Übungsstoff als Info", () => {
    const { termine } = lies([ECHTE_ZEILEN[3]!]);
    expect(termine).toEqual([
      {
        uid: expect.stringMatching(/^html-[0-9a-f]{24}$/),
        titel: "Atemschutz (Trocken) / OC",
        ganztaegig: false,
        // 08.07.2026 ist Sommerzeit (UTC+2)
        beginn: new Date("2026-07-08T17:00:00Z"),
        ende: new Date("2026-07-08T19:30:00Z"),
        tagVon: null,
        tagBis: null,
        thema: null,
        info: "Meilen",
        aufgebot: null,
        art: "Übung",
      },
    ]);
  });

  test("Winterzeit: 16.01.2026 17:30 ist 16:30 UTC", () => {
    const { termine } = lies([ECHTE_ZEILEN[0]!]);
    expect(termine[0]).toMatchObject({
      titel: "Kdt. Rapport / 100. DV",
      beginn: new Date("2026-01-16T16:30:00Z"),
      ende: new Date("2026-01-16T21:00:00Z"),
      art: "Sitzung",
    });
  });

  test("ein Mehrtagestermin mit Zeit läuft vom Beginn am ersten bis zum Ende am letzten Tag", () => {
    const { termine } = lies([ECHTE_ZEILEN[2]!]);
    expect(termine[0]).toMatchObject({
      ganztaegig: false,
      beginn: new Date("2026-06-19T17:00:00Z"),
      ende: new Date("2026-06-20T20:00:00Z"),
      art: "Kurs",
    });
  });

  test("ohne Zeit ist der Termin ganztägig, auch über mehrere Tage", () => {
    const { termine } = lies([
      ["Sa", "04.07.2026", "", "Dorffest", "", "Anlass"],
      ["Mo", "13.07.2026 - 17.07.2026", "", "Lager", "", "Kurs"],
    ]);
    expect(termine[0]).toMatchObject({
      ganztaegig: true,
      beginn: null,
      ende: null,
      tagVon: "2026-07-04",
      tagBis: "2026-07-04",
    });
    expect(termine[1]).toMatchObject({
      tagVon: "2026-07-13",
      tagBis: "2026-07-17",
    });
  });

  test("eine unlesbare Zeit macht den Termin ganztägig statt ihn zu verwerfen", () => {
    const { termine } = lies([
      ["Sa", "04.07.2026", "ab Mittag", "X", "", "Anlass"],
    ]);
    expect(termine[0]).toMatchObject({
      ganztaegig: true,
      tagVon: "2026-07-04",
    });
  });

  test("ohne Thema steht die Art im Titel", () => {
    const { termine } = lies([ECHTE_ZEILEN[8]!]);
    expect(termine[0]).toMatchObject({
      titel: "Kurs",
      art: "Kurs",
      info: null,
    });
  });

  test("Umlaute, Entitäten und Leerzeichen", () => {
    const { termine } = lies([
      [
        "Sa",
        "26.09.2026",
        "11:00 - 19:00",
        "Tag der offenen T&uuml;re &amp;  Fest <b>1</b>",
        "Z&#252;rich",
        "Anlass",
      ],
    ]);
    expect(termine[0]).toMatchObject({
      titel: "Tag der offenen Türe & Fest 1",
      info: "Zürich",
    });
  });

  test("die UID bleibt, wenn sich nur die Zeit ändert; Thema oder Tag ändern sie", () => {
    const uid = (z: Zeile) => lies([z]).termine[0]!.uid;
    const basis: Zeile = [
      "Mi",
      "21.10.2026",
      "19:00 - 21:30",
      "Sanitätsübung",
      "",
      "Übung",
    ];
    expect(
      uid([basis[0], basis[1], "18:00 - 20:00", ...basis.slice(3)] as Zeile),
    ).toBe(uid(basis));
    expect(uid([basis[0], basis[1], basis[2], "Funk", "", "Übung"])).not.toBe(
      uid(basis),
    );
    expect(uid([basis[0], "28.10.2026", ...basis.slice(2)] as Zeile)).not.toBe(
      uid(basis),
    );
  });

  test("gleiches Datum und Thema: die UIDs bleiben verschieden und stabil in der Reihenfolge der Seite", () => {
    const a = lies(ECHTE_ZEILEN);
    const b = lies(ECHTE_ZEILEN);
    // 11 Zeilen, zwei davon doppelt (J-NH Nothilfekurs am 18.09.)
    expect(a.termine).toHaveLength(11);
    expect(new Set(a.termine.map((t) => t.uid)).size).toBe(11);
    expect(a.uids).toEqual(new Set(a.termine.map((t) => t.uid)));
    expect(b.termine.map((t) => t.uid)).toEqual(a.termine.map((t) => t.uid));
    const doppelt = a.termine.filter((t) => t.titel === "J-NH Nothilfekurs");
    expect(doppelt.map((t) => t.uid.endsWith("-2"))).toEqual([
      false,
      false,
      true,
    ]);
  });

  test("überspringt Zeilen ohne lesbares Datum und mit zu wenig Zellen", () => {
    const html = lodurSeite([
      ["Sa", "31.02.2026", "19:00", "Kein Tag", "", "Übung"],
      ["Sa", "bald", "19:00", "Kein Datum", "", "Übung"],
      ["Sa", "04.07.2026", "19:00", "Gut", "", "Übung"],
    ]).replace("</tbody>", "<tr><td>nur eine Zelle</td></tr></tbody>");
    expect(leseLodurSeite(html).termine.map((t) => t.titel)).toEqual(["Gut"]);
  });

  test("ein Jahr ohne Termine ist eine gültige, leere Liste", () => {
    expect(lies([])).toEqual({ termine: [], uids: new Set() });
  });

  test("eine andere Seite ist kein Kalender", () => {
    expect(() => leseLodurSeite("<html><body>Anmelden</body></html>")).toThrow(
      SeitenFehler,
    );
    expect(() => leseLodurSeite("")).toThrow(SeitenFehler);
  });
});
