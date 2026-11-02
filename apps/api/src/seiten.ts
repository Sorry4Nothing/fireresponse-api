import { readdirSync, readFileSync } from "node:fs";
import { KATEGORIEN } from "./datenkategorien.js";
import { EINWILLIGUNG_VERSION } from "./einwilligung.js";

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

// Die Datenkategorien der Datenschutzerklärung kommen aus datenkategorien.ts, damit Seite, Schema und Store-Angaben dieselbe Quelle haben
export function kategorienHtml() {
  return Object.values(KATEGORIEN)
    .map(
      (k) => `<section class="kategorie">
        <h3>${maskiere(k.titel)}</h3>
        <dl>
          <dt>Wozu</dt>
          <dd>${maskiere(k.zweck)}</dd>
          <dt>Wie lange</dt>
          <dd>${maskiere(k.frist)}</dd>
        </dl>
      </section>`,
    )
    .join("\n      ");
}

// Ohne Angabe bleibt die Seite lesbar, nennt aber keine erfundene Stelle oder Adresse
export function setzeKontakt(html: string, { stelle, email }: Kontakt) {
  return html
    .replaceAll("{{KATEGORIEN}}", kategorienHtml())
    .replaceAll("{{FASSUNG}}", String(EINWILLIGUNG_VERSION))
    .replaceAll("{{STELLE}}", stelle ? maskiere(stelle) : "die Einheit")
    .replaceAll(
      "{{KONTAKT}}",
      email
        ? `<a href="mailto:${maskiere(email)}">${maskiere(email)}</a>`
        : "die Adresse der Einheit (noch nicht eingetragen)",
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
    nutzungsbedingungen: seite("nutzungsbedingungen.html"),
    support: seite("support.html"),
  };
}
