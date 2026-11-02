import postgres from "postgres";

// Ohne NOTICEs: postgres-js schriebe sie selbst mit console.log, am Log vorbei, ohne Request-ID (der Rückruf kennt keine Anfrage) und mit Text aus der Datenbank
// Nie { max: undefined } übergeben: postgres-js zählt den blossen Schlüssel und öffnete dann genau eine Verbindung
export function verbindeDatenbank(
  url: string,
  optionen: { max?: number } = {},
) {
  return postgres(url, { ...optionen, onnotice: () => {} });
}
