import { describe, expect, test } from "vitest";

// Die Datumslogik des Datepickers der Verwaltung liegt in public/admin/datum.js, ohne Seitenbezug. Die Datei hat keine Typen; ein Pfad aus einer URL hält den Import ungeprüft
interface Zelle {
  iso: string;
  imMonat: boolean;
}
const datum = (await import(
  new URL("../public/admin/datum.js", import.meta.url).href
)) as {
  teile(iso: string): number[] | null;
  parseDe(text: string): string | null;
  formatDe(iso: string): string;
  langDe(iso: string): string;
  wochentag(iso: string): number;
  heute(jetzt?: Date): string;
  verschiebe(
    iso: string,
    schritt: { tage?: number; monate?: number; jahre?: number },
  ): string;
  imBereich(iso: string, min: string, max: string): boolean;
  begrenze(iso: string, min: string, max: string): string;
  monatErlaubt(jahr: number, monat: number, min: string, max: string): boolean;
  monatsraster(jahr: number, monat: number): Zelle[][];
  tageImMonat(jahr: number, monat: number): number;
};

describe("Datumslogik des Datepickers", () => {
  test("teile: nur echte Kalendertage", () => {
    expect(datum.teile("2026-03-05")).toEqual([2026, 3, 5]);
    expect(datum.teile("2024-02-29")).toEqual([2024, 2, 29]);
    for (const falsch of [
      "2026-02-29",
      "2026-04-31",
      "2026-13-01",
      "2026-00-10",
      "2026-01-00",
      "0999-01-01",
      "2026-3-5",
      "05.03.2026",
      "",
      null,
      undefined,
    ]) {
      expect(datum.teile(falsch as string)).toBeNull();
    }
  });

  test("parseDe: TT.MM.JJJJ, auch ohne führende Nullen und mit Leerraum", () => {
    expect(datum.parseDe("05.03.2026")).toBe("2026-03-05");
    expect(datum.parseDe("5.3.2026")).toBe("2026-03-05");
    expect(datum.parseDe(" 31.12.2026 ")).toBe("2026-12-31");
    expect(datum.parseDe("29.02.2024")).toBe("2024-02-29");
  });

  test("parseDe: ungültiger Text ergibt null", () => {
    for (const falsch of [
      "29.02.2026",
      "31.04.2026",
      "00.01.2026",
      "1.13.2026",
      "5.3.26",
      "2026-03-05",
      "05/03/2026",
      "05.03.2026 x",
      "",
    ]) {
      expect(datum.parseDe(falsch)).toBeNull();
    }
  });

  test("formatDe: umgekehrt zu parseDe, ungültig ergibt leeren Text", () => {
    expect(datum.formatDe("2026-03-05")).toBe("05.03.2026");
    expect(datum.parseDe(datum.formatDe("2026-12-31"))).toBe("2026-12-31");
    expect(datum.formatDe("")).toBe("");
    expect(datum.formatDe("2026-02-30")).toBe("");
  });

  test("langDe: Tag, deutscher Monat, Jahr und Wochentag; beginnt mit dem sichtbaren Tag", () => {
    expect(datum.langDe("2026-03-05")).toBe("5. März 2026, Donnerstag");
    expect(datum.langDe("2026-11-01")).toBe("1. November 2026, Sonntag");
  });

  test("wochentag: Montag ist 0", () => {
    expect(datum.wochentag("2026-11-02")).toBe(0);
    expect(datum.wochentag("2026-11-08")).toBe(6);
    expect(datum.wochentag("2000-01-01")).toBe(5);
  });

  test("heute: lokales Datum des Geräts, nicht UTC", () => {
    expect(datum.heute(new Date(2026, 0, 2, 0, 30))).toBe("2026-01-02");
    expect(datum.heute(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });

  test("verschiebe: Tage über Monats- und Jahresgrenzen", () => {
    expect(datum.verschiebe("2026-01-31", { tage: 1 })).toBe("2026-02-01");
    expect(datum.verschiebe("2026-01-01", { tage: -1 })).toBe("2025-12-31");
    expect(datum.verschiebe("2024-02-28", { tage: 2 })).toBe("2024-03-01");
    // Sommerzeit-Wechsel verschiebt nichts
    expect(datum.verschiebe("2026-03-28", { tage: 2 })).toBe("2026-03-30");
    expect(datum.verschiebe("2026-10-24", { tage: 2 })).toBe("2026-10-26");
  });

  test("verschiebe: Monate und Jahre lassen den Tag im Zielmonat", () => {
    expect(datum.verschiebe("2026-01-31", { monate: 1 })).toBe("2026-02-28");
    expect(datum.verschiebe("2024-01-31", { monate: 1 })).toBe("2024-02-29");
    expect(datum.verschiebe("2026-12-15", { monate: 1 })).toBe("2027-01-15");
    expect(datum.verschiebe("2026-01-15", { monate: -1 })).toBe("2025-12-15");
    expect(datum.verschiebe("2024-02-29", { jahre: 1 })).toBe("2025-02-28");
    expect(datum.verschiebe("2026-03-05", { jahre: -2 })).toBe("2024-03-05");
  });

  test("imBereich und begrenze: Grenzen gelten einschliesslich, leere Grenze gilt nicht", () => {
    expect(datum.imBereich("2026-05-10", "2026-05-10", "2026-05-20")).toBe(
      true,
    );
    expect(datum.imBereich("2026-05-20", "2026-05-10", "2026-05-20")).toBe(
      true,
    );
    expect(datum.imBereich("2026-05-09", "2026-05-10", "2026-05-20")).toBe(
      false,
    );
    expect(datum.imBereich("2026-05-21", "2026-05-10", "2026-05-20")).toBe(
      false,
    );
    expect(datum.imBereich("1999-01-01", "", "")).toBe(true);
    expect(datum.imBereich("2030-01-01", "2026-05-10", "")).toBe(true);
    expect(datum.begrenze("2026-01-01", "2026-05-10", "2026-05-20")).toBe(
      "2026-05-10",
    );
    expect(datum.begrenze("2026-12-01", "2026-05-10", "2026-05-20")).toBe(
      "2026-05-20",
    );
    expect(datum.begrenze("2026-05-15", "2026-05-10", "2026-05-20")).toBe(
      "2026-05-15",
    );
    expect(datum.begrenze("2026-05-15", "", "")).toBe("2026-05-15");
  });

  test("monatErlaubt: ein Monat zählt, sobald ein Tag darin erlaubt ist", () => {
    expect(datum.monatErlaubt(2026, 4, "2026-05-10", "2026-07-20")).toBe(false);
    expect(datum.monatErlaubt(2026, 5, "2026-05-31", "2026-07-20")).toBe(true);
    expect(datum.monatErlaubt(2026, 7, "2026-05-10", "2026-07-01")).toBe(true);
    expect(datum.monatErlaubt(2026, 8, "2026-05-10", "2026-07-31")).toBe(false);
    expect(datum.monatErlaubt(2026, 8, "", "")).toBe(true);
  });

  test("monatsraster: sechs Wochen, Montag zuerst, lückenlos", () => {
    // November 2026 beginnt an einem Sonntag
    const raster = datum.monatsraster(2026, 11);
    expect(raster).toHaveLength(6);
    expect(raster.every((woche) => woche.length === 7)).toBe(true);
    expect(raster[0][0]).toEqual({ iso: "2026-10-26", imMonat: false });
    expect(raster[0][6]).toEqual({ iso: "2026-11-01", imMonat: true });
    expect(raster[1][0].iso).toBe("2026-11-02");
    expect(raster[5][6].iso).toBe("2026-12-06");
    const alle = raster.flat();
    expect(alle.filter((z) => z.imMonat)).toHaveLength(30);
    for (let i = 1; i < alle.length; i++) {
      expect(datum.verschiebe(alle[i - 1].iso, { tage: 1 })).toBe(alle[i].iso);
    }
  });

  test("monatsraster: Monat, der an einem Montag beginnt, hat keine Vortage", () => {
    // Juni 2026 beginnt an einem Montag, Februar 2027 auch
    expect(datum.monatsraster(2026, 6)[0][0]).toEqual({
      iso: "2026-06-01",
      imMonat: true,
    });
    expect(datum.monatsraster(2027, 2)[0][0]).toEqual({
      iso: "2027-02-01",
      imMonat: true,
    });
  });

  test("monatsraster: Schaltjahr und Jahreswechsel", () => {
    const feb = datum.monatsraster(2024, 2).flat();
    expect(feb.filter((z) => z.imMonat)).toHaveLength(29);
    expect(datum.tageImMonat(2024, 2)).toBe(29);
    expect(datum.tageImMonat(2026, 2)).toBe(28);
    const jan = datum.monatsraster(2026, 1);
    expect(jan[0][0].iso).toBe("2025-12-29");
    expect(jan[0][0].imMonat).toBe(false);
  });
});
