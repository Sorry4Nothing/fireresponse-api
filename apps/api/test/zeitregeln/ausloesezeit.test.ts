import { describe, expect, test } from "vitest";
import { ausloesezeit, kurzDatum } from "../../src/zeitregeln/ausloesezeit.js";

const iso = (d: Date) => d.toISOString();
const MI = 3;

describe("ausloesezeit", () => {
  test("Winterzeit: Mittwoch 08:00 vor dem Samstag", () => {
    // Sa 31.10.2026 14:00 MEZ, Mi 28.10. 08:00 MEZ
    expect(
      iso(ausloesezeit(new Date("2026-10-31T13:00:00Z"), MI, "08:00")),
    ).toBe("2026-10-28T07:00:00.000Z");
  });

  test("Sommerzeit: dieselbe Wanduhrzeit liegt eine Stunde früher in UTC", () => {
    // Sa 20.6.2026 14:00 MESZ, Mi 17.6. 08:00 MESZ
    expect(
      iso(ausloesezeit(new Date("2026-06-20T12:00:00Z"), MI, "08:00")),
    ).toBe("2026-06-17T06:00:00.000Z");
  });

  test("Umstellung im Herbst zwischen Auslösung und Beginn", () => {
    // Mo 26.10.2026 09:00 MEZ; So 25.10. 08:00 MEZ (Umstellung war um 03:00)
    expect(
      iso(ausloesezeit(new Date("2026-10-26T08:00:00Z"), 7, "08:00")),
    ).toBe("2026-10-25T07:00:00.000Z");
    // Sa 24.10. 20:00 MESZ, also vor der Umstellung
    expect(
      iso(ausloesezeit(new Date("2026-10-26T08:00:00Z"), 6, "20:00")),
    ).toBe("2026-10-24T18:00:00.000Z");
  });

  test("Umstellung im Frühling zwischen Auslösung und Beginn", () => {
    // Mo 30.3.2026 09:00 MESZ; So 29.3. 08:00 MESZ (Umstellung war um 02:00)
    expect(
      iso(ausloesezeit(new Date("2026-03-30T07:00:00Z"), 7, "08:00")),
    ).toBe("2026-03-29T06:00:00.000Z");
    // Sa 28.3. 08:00 MEZ
    expect(
      iso(ausloesezeit(new Date("2026-03-30T07:00:00Z"), 6, "08:00")),
    ).toBe("2026-03-28T07:00:00.000Z");
  });

  test("gleicher Wochentag: nach dem Beginn gilt die Vorwoche, genau zum Beginn der Beginn selbst", () => {
    // Mi 28.10.2026 07:00 MEZ
    const beginn = new Date("2026-10-28T06:00:00Z");
    expect(iso(ausloesezeit(beginn, MI, "08:00"))).toBe(
      "2026-10-21T06:00:00.000Z",
    );
    expect(iso(ausloesezeit(beginn, MI, "07:00"))).toBe(iso(beginn));
    expect(iso(ausloesezeit(beginn, MI, "06:59"))).toBe(
      "2026-10-28T05:59:00.000Z",
    );
  });

  test("ganztägiges Programm beginnt um 00:00 Schweizer Zeit", () => {
    // Sa 31.10.2026 00:00 MEZ; Sa 24.10. 08:00 MESZ
    expect(
      iso(ausloesezeit(new Date("2026-10-30T23:00:00Z"), 6, "08:00")),
    ).toBe("2026-10-24T06:00:00.000Z");
    // Fr 30.10. 23:30 MEZ liegt vor dem Beginn
    expect(
      iso(ausloesezeit(new Date("2026-10-30T23:00:00Z"), 5, "23:30")),
    ).toBe("2026-10-30T22:30:00.000Z");
  });

  test("Uhrzeit in der übersprungenen Stunde rückt auf die nächste Stunde", () => {
    // So 29.3.2026 02:30 gibt es nicht; es gilt 03:30 MESZ
    expect(
      iso(ausloesezeit(new Date("2026-03-30T07:00:00Z"), 7, "02:30")),
    ).toBe("2026-03-29T01:30:00.000Z");
  });
});

describe("kurzDatum", () => {
  test("Tag in Schweizer Zeit, nicht in UTC", () => {
    expect(kurzDatum(new Date("2026-10-31T13:00:00Z"))).toBe("Sa 31.10.");
    expect(kurzDatum(new Date("2026-10-30T23:00:00Z"))).toBe("Sa 31.10.");
    expect(kurzDatum(new Date("2026-06-20T22:30:00Z"))).toBe("So 21.6.");
  });
});
