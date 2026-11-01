import { readdirSync, readFileSync } from "node:fs";

// Wer die Seiten verantwortet und wie man sie erreicht; kommt aus der Umgebung des Servers, nie aus dem Repo
export type Kontakt = { stelle?: string; email?: string };

const MASKE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const maskiere = (text: string) => text.replace(/[&<>"']/g, (z) => MASKE[z]!);

// Ohne Angabe bleibt die Seite lesbar, nennt aber keine erfundene Stelle oder Adresse
export function setzeKontakt(html: string, { stelle, email }: Kontakt) {
  return html
    .replaceAll("{{STELLE}}", stelle ? maskiere(stelle) : "die Abteilung")
    .replaceAll(
      "{{KONTAKT}}",
      email
        ? `<a href="mailto:${maskiere(email)}">${maskiere(email)}</a>`
        : "die Adresse der Abteilung (noch nicht eingetragen)",
    );
}

// Nur server.ts und Tests importieren diese Datei: node:fs bleibt aus dem Graph von app.ts, den die App über AppType prüft
export function ladeSeiten(kontakt: Kontakt = {}) {
  const lade = (datei: string) =>
    readFileSync(new URL(`../public/${datei}`, import.meta.url), "utf8");
  // Alle Dateien aus public/admin; neue Module brauchen keine Änderung hier
  const admin = Object.fromEntries(
    readdirSync(new URL("../public/admin/", import.meta.url))
      .sort()
      .map((datei) => [datei, lade(`admin/${datei}`)]),
  );
  // Der Stil liegt einmal in seite.css; die CSP-freien Seiten setzen ihn ein, statt ihn zu laden
  const stil = lade("seite.css");
  const seite = (datei: string) =>
    setzeKontakt(
      lade(datei).replace("/* STIL */", () => stil),
      kontakt,
    );
  return {
    admin,
    datenschutz: seite("datenschutz.html"),
    kontoLoeschen: seite("konto-loeschen.html"),
    support: seite("support.html"),
  };
}
