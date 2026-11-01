import { Hono } from "hono";

// Dateiname -> Inhalt; index.html liegt unter /admin, alle anderen unter /admin/<Dateiname>
export type AdminDateien = Record<string, string>;

const TYPEN: Record<string, string> = {
  html: "text/html; charset=UTF-8",
  css: "text/css; charset=UTF-8",
  js: "text/javascript; charset=UTF-8",
  svg: "image/svg+xml",
};

// Nichts Fremdes: Skript, Stil, Bild (data: für Symbole) und Verbindungen nur von der eigenen Herkunft; die Seite lässt sich nicht einbetten
const KOPFZEILEN = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // Für Browser, die frame-ancestors nicht kennen
  "X-Frame-Options": "DENY",
};

// Nur die statische Hülle, ohne Login: Daten gibt es erst über /api/v1/admin/* mit Sitzung und zweitem Faktor. Jede Datei hat ihre eigene Route (kein use() mit Platzhalter), damit die Rechte-Matrix jede kennt
export function erstelleAdminSeiten(dateien: AdminDateien) {
  const routen = new Hono();
  for (const [name, inhalt] of Object.entries(dateien)) {
    const endung = name.slice(name.lastIndexOf(".") + 1);
    const pfad = name === "index.html" ? "/" : `/${name}`;
    routen.get(pfad, (c) => {
      c.header("Content-Type", TYPEN[endung]);
      for (const [kopf, wert] of Object.entries(KOPFZEILEN)) {
        c.header(kopf, wert);
      }
      // Die Seite enthält zwar keine Daten, soll aber nach einem Abmelden nie aus dem Zwischenspeicher zurückkommen
      c.header("Cache-Control", endung === "html" ? "no-store" : "no-cache");
      return c.body(inhalt);
    });
  }
  return routen;
}
