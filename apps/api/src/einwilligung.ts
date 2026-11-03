// Fassung der Einwilligung beim ersten Start. Eine neue Fassung heisst: neu fragen (die Version steigt). Sie steigt auch, wenn sich die Datenschutzerklärung oder die Nutzungsbedingungen (public/*.html) inhaltlich ändern; die Seiten zeigen diese Nummer als «Fassung»
export const EINWILLIGUNG_VERSION = 2;

// Die Apps zeigen den Text, den die API liefert, mit Verweisen auf die beiden Seiten. Entwurf, rechtlich noch zu prüfen (docs/datenschutz/README.md)
export const EINWILLIGUNG_TEXT =
  "FireResponse bearbeitet Personendaten, damit deine Einheit Übungen planen und Anmeldungen führen kann: Namen, Anmeldungen und Rollen, bei Leitenden und beim Kommando auch Kontaktangaben. Wie das geschieht, steht in der Datenschutzerklärung (/datenschutz) und in den Nutzungsbedingungen (/nutzungsbedingungen). Mit deiner Zustimmung bestätigst du, dass du beide gelesen hast und einverstanden bist. Bei Kindern stimmen die Eltern zu.";
