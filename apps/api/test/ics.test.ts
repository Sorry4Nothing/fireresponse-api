import { describe, expect, test } from "vitest";
import { IcsFehler, leseIcs } from "../src/ics.js";

// Erfundene Kalender im Schema von Lodur: UTC ohne VTIMEZONE, leerer Ort, «\n» am Ende des Titels
const kalender = (...ereignisse: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Beispiel//Kalender//DE",
    ...ereignisse,
    "END:VCALENDAR",
    "",
  ].join("\r\n");

const ereignis = (...zeilen: string[]) =>
  [
    "BEGIN:VEVENT",
    "UID:uebung-1001@kalender.example.org",
    "DTSTAMP:20261102T080000Z",
    "CREATED:20261102T080000Z",
    "LAST-MODIFIED:20261102T080000Z",
    "LOCATION:",
    ...zeilen,
    "END:VEVENT",
  ].join("\r\n");

const GRUNDZEILEN = [
  "DTSTART:20261114T080000Z",
  "DTEND:20261114T100000Z",
  String.raw`SUMMARY:Übung Schläuche\n`,
  String.raw`DESCRIPTION:Thema/Dienst: Schläuche kuppeln\nInfo: Handschuhe mitbringen\, wir sind draussen.\nVerantwortlich: Erfundene Person\nAufgebot: 08:45 Uhr im Magazin`,
];

describe("leseIcs", () => {
  test("liest Titel, Zeiten in UTC und die Felder der Beschreibung", () => {
    const { termine, uids } = leseIcs(kalender(ereignis(...GRUNDZEILEN)));
    expect(termine).toEqual([
      {
        uid: "uebung-1001@kalender.example.org",
        titel: "Übung Schläuche",
        ganztaegig: false,
        beginn: new Date("2026-11-14T08:00:00Z"),
        ende: new Date("2026-11-14T10:00:00Z"),
        tagVon: null,
        tagBis: null,
        thema: "Schläuche kuppeln",
        info: "Handschuhe mitbringen, wir sind draussen.",
        aufgebot: "08:45 Uhr im Magazin",
      },
    ]);
    expect([...uids]).toEqual(["uebung-1001@kalender.example.org"]);
  });

  test("speichert «Verantwortlich» nie", () => {
    const text = JSON.stringify(leseIcs(kalender(ereignis(...GRUNDZEILEN))));
    expect(text).not.toContain("Erfundene Person");
    expect(text).not.toContain("Verantwortlich");
  });

  test("entfernt das wörtliche «\\n» am Titel, mit und ohne Escape des Backslash", () => {
    for (const summary of [
      String.raw`SUMMARY:Hauptübung\n`,
      String.raw`SUMMARY:Hauptübung\\n`,
      String.raw`SUMMARY:Hauptübung\n\n`,
      "SUMMARY:Hauptübung  ",
    ]) {
      const { termine } = leseIcs(
        kalender(ereignis("DTSTART:20261114T080000Z", summary)),
      );
      expect(termine[0]!.titel, summary).toBe("Hauptübung");
    }
  });

  test("entschlüsselt Komma, Semikolon, Backslash und Zeilenumbruch", () => {
    const { termine } = leseIcs(
      kalender(
        ereignis(
          "DTSTART:20261114T080000Z",
          String.raw`SUMMARY:A\, B\; C \\ D`,
          String.raw`DESCRIPTION:Info: Zeile eins\nZeile zwei\nAufgebot: pünktlich`,
        ),
      ),
    );
    expect(termine[0]!.titel).toBe(String.raw`A, B; C \ D`);
    expect(termine[0]!.info).toBe("Zeile eins\nZeile zwei");
    expect(termine[0]!.aufgebot).toBe("pünktlich");
  });

  test("setzt gefaltete Zeilen wieder zusammen, mit CRLF und mit LF", () => {
    const gefaltet = ereignis(
      "DTSTART:20261114T080000Z",
      "SUMMARY:Ein sehr lan",
      " ger Titel mit Falz",
      "\tund Tab",
      String.raw`DESCRIPTION:Thema/Dienst: Funk\nAufgebot: 08:45 Uh`,
      " r im Magazin",
    );
    for (const text of [
      kalender(gefaltet),
      kalender(gefaltet).replaceAll("\r\n", "\n"),
    ]) {
      const { termine } = leseIcs(text);
      expect(termine[0]!.titel).toBe("Ein sehr langer Titel mit Falzund Tab");
      expect(termine[0]!.thema).toBe("Funk");
      expect(termine[0]!.aufgebot).toBe("08:45 Uhr im Magazin");
    }
  });

  test("ohne die Felder der Beschreibung sind sie leer", () => {
    const { termine } = leseIcs(
      kalender(
        ereignis(
          "DTSTART:20261114T080000Z",
          "SUMMARY:Ohne Beschreibung",
          "DESCRIPTION:",
        ),
      ),
    );
    expect(termine[0]).toMatchObject({
      thema: null,
      info: null,
      aufgebot: null,
    });
  });

  test("ohne DTEND endet der Termin, wann er beginnt", () => {
    const { termine } = leseIcs(
      kalender(ereignis("DTSTART:20261114T080000Z", "SUMMARY:Kurz")),
    );
    expect(termine[0]!.ende).toEqual(termine[0]!.beginn);
  });

  test("ganztägige Termine: DTEND ist exklusiv", () => {
    const { termine } = leseIcs(
      kalender(
        ereignis(
          "DTSTART;VALUE=DATE:20261114",
          "DTEND;VALUE=DATE:20261116",
          "SUMMARY:Lager",
        ),
        ereignis("DTSTART;VALUE=DATE:20261120", "SUMMARY:Ein Tag").replace(
          "uebung-1001",
          "uebung-1002",
        ),
      ),
    );
    expect(termine[0]).toMatchObject({
      ganztaegig: true,
      beginn: null,
      ende: null,
      tagVon: "2026-11-14",
      tagBis: "2026-11-15",
    });
    expect(termine[1]).toMatchObject({
      tagVon: "2026-11-20",
      tagBis: "2026-11-20",
    });
  });

  test("Eigenschaften einer VALARM gehören nicht zum Termin", () => {
    const { termine } = leseIcs(
      kalender(
        ereignis(
          ...GRUNDZEILEN,
          "BEGIN:VALARM",
          "ACTION:DISPLAY",
          "DESCRIPTION:Erinnerung",
          "END:VALARM",
        ),
      ),
    );
    expect(termine[0]!.thema).toBe("Schläuche kuppeln");
    expect(termine).toHaveLength(1);
  });

  test("ein unlesbarer Termin fehlt in der Liste, seine UID bleibt bekannt", () => {
    const { termine, uids } = leseIcs(
      kalender(
        ereignis("DTSTART:morgen", "SUMMARY:Kaputt"),
        ereignis("DTSTART:20261331T080000Z", "SUMMARY:Monat 13").replace(
          "uebung-1001",
          "uebung-1002",
        ),
        ereignis(...GRUNDZEILEN).replace("uebung-1001", "uebung-1003"),
      ),
    );
    expect(termine.map((t) => t.uid)).toEqual([
      "uebung-1003@kalender.example.org",
    ]);
    expect([...uids].sort()).toEqual([
      "uebung-1001@kalender.example.org",
      "uebung-1002@kalender.example.org",
      "uebung-1003@kalender.example.org",
    ]);
  });

  test("ein gestrichener Termin gilt wie ein fehlender", () => {
    const { termine, uids } = leseIcs(
      kalender(ereignis(...GRUNDZEILEN, "STATUS:CANCELLED")),
    );
    expect(termine).toEqual([]);
    expect(uids.size).toBe(0);
  });

  test("dieselbe UID zweimal: der letzte Eintrag gilt", () => {
    const { termine } = leseIcs(
      kalender(
        ereignis("DTSTART:20261114T080000Z", "SUMMARY:Alt"),
        ereignis("DTSTART:20261114T080000Z", "SUMMARY:Neu"),
      ),
    );
    expect(termine.map((t) => t.titel)).toEqual(["Neu"]);
  });

  test("ein leerer Kalender ist gültig", () => {
    expect(leseIcs(kalender())).toEqual({ termine: [], uids: new Set() });
  });

  test.each(["", "<html>Anmelden</html>", "BEGIN:VEVENT\r\nEND:VEVENT"])(
    "%j ist kein Kalender",
    (text) => {
      expect(() => leseIcs(text)).toThrow(IcsFehler);
    },
  );
});
