import { describe, expect, test } from "vitest";
import {
  erstelleMetriken,
  MAX_FEHLER,
  MAX_ROUTEN,
  MINUTEN,
} from "../src/metriken.js";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 0, 1, 12, 0, 30);

function uhr(start = T0) {
  let jetzt = start;
  return {
    jetzt: () => jetzt,
    weiter: (ms: number) => (jetzt += ms),
  };
}

const antwort = (
  route: string,
  status = 200,
  dauerMs = 3,
  methode = "GET",
) => ({
  methode,
  route,
  status,
  dauerMs,
});

describe("Metriken im Arbeitsspeicher", () => {
  test("ohne Anfragen sind alle Zahlen leer", () => {
    const m = erstelleMetriken(uhr().jetzt).momentaufnahme();
    expect(m).toMatchObject({
      gesamt: 0,
      letzteMinute: 0,
      letzteStunde: 0,
      quote5xx: 0,
      p50Ms: null,
      p95Ms: null,
      routen: [],
      letzteFehler: [],
    });
    expect(m.stunden).toHaveLength(24);
    expect(m.minuten).toHaveLength(60);
  });

  test("zählt nach Statusklasse, Minute und Stunde", () => {
    const u = uhr();
    const m = erstelleMetriken(u.jetzt);
    m.erfasse(antwort("/a"));
    m.erfasse(antwort("/a", 404));
    u.weiter(5 * MINUTE);
    m.erfasse(antwort("/a", 500));
    m.erfasse(antwort("/b", 204));
    const s = m.momentaufnahme();
    expect(s.gesamt).toBe(4);
    expect(s.letzteMinute).toBe(2);
    expect(s.letzteStunde).toBe(4);
    expect(s.statusklassen).toEqual({
      "1xx": 0,
      "2xx": 2,
      "3xx": 0,
      "4xx": 1,
      "5xx": 1,
    });
    expect(s.quote5xx).toBe(0.25);
    expect(s.minuten.at(-1)).toMatchObject({ anzahl: 2, fehler5xx: 1 });
    expect(s.minuten.at(-6)).toMatchObject({ anzahl: 2, fehler4xx: 1 });
    expect(s.stunden.at(-1)).toMatchObject({
      anzahl: 4,
      fehler4xx: 1,
      fehler5xx: 1,
    });
  });

  test("Zähler je Routenmuster, häufigste zuerst, mit Fehlern und Dauer", () => {
    const m = erstelleMetriken(uhr().jetzt);
    for (let i = 0; i < 10; i++) m.erfasse(antwort("/x/:id", 200, 4));
    m.erfasse(antwort("/x/:id", 500, 900));
    m.erfasse(antwort("/y", 403, 4, "POST"));
    const [x, y] = m.momentaufnahme().routen;
    expect(x).toEqual({
      methode: "GET",
      route: "/x/:id",
      anzahl: 11,
      fehler4xx: 0,
      fehler5xx: 1,
      p50Ms: 5,
      p95Ms: 1000,
    });
    expect(y).toMatchObject({ methode: "POST", route: "/y", fehler4xx: 1 });
  });

  test("Perzentile sind die Obergrenze der Dauerklasse", () => {
    const m = erstelleMetriken(uhr().jetzt);
    for (let i = 0; i < 90; i++) m.erfasse(antwort("/a", 200, 8));
    for (let i = 0; i < 10; i++) m.erfasse(antwort("/a", 200, 700));
    const s = m.momentaufnahme();
    expect(s.p50Ms).toBe(10);
    expect(s.p95Ms).toBe(1000);
  });

  test("ein Eimer wird nach 24 Stunden neu verwendet und vorher geleert", () => {
    const u = uhr();
    const m = erstelleMetriken(u.jetzt);
    m.erfasse(antwort("/a"));
    u.weiter((MINUTEN - 1) * MINUTE);
    // Die letzte Minute des Fensters: noch dabei
    expect(m.momentaufnahme().gesamt).toBe(1);
    u.weiter(MINUTE);
    // Genau 24 Stunden später fällt die alte Minute aus dem Fenster
    expect(m.momentaufnahme().gesamt).toBe(0);
    // Dieselbe Eimer-Position, neue Minute: nur die neue Anfrage zählt
    m.erfasse(antwort("/a", 500));
    const s = m.momentaufnahme();
    expect(s.gesamt).toBe(1);
    expect(s.statusklassen["5xx"]).toBe(1);
    expect(s.statusklassen["2xx"]).toBe(0);
  });

  test("der Speicher bleibt begrenzt: Routen und Fehler haben eine Obergrenze", () => {
    const m = erstelleMetriken(uhr().jetzt);
    for (let i = 0; i < MAX_ROUTEN + 20; i++) m.erfasse(antwort(`/r${i}`));
    const routen = m.momentaufnahme().routen;
    expect(routen).toHaveLength(MAX_ROUTEN + 1);
    expect(routen.find((r) => r.route === "andere")).toMatchObject({
      anzahl: 20,
      methode: "",
    });
    for (let i = 0; i < MAX_FEHLER + 5; i++) m.erfasse(antwort("/f", 400 + i));
    const fehler = m.momentaufnahme().letzteFehler;
    expect(fehler).toHaveLength(MAX_FEHLER);
    // Neueste zuerst
    expect(fehler[0].status).toBe(400 + MAX_FEHLER + 4);
  });

  test("Fehler tragen nur Zeit, Methode, Route und Status", () => {
    const m = erstelleMetriken(uhr().jetzt);
    m.erfasse(antwort("/a/:id", 404));
    expect(Object.keys(m.momentaufnahme().letzteFehler[0]).sort()).toEqual([
      "methode",
      "route",
      "status",
      "zeit",
    ]);
  });
});
