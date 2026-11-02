// Alle Aufrufe gegen die eigene Herkunft. Die Sitzung liegt nur im Cookie des Browsers (httpOnly); die Seite speichert nichts davon.

export class ApiFehler extends Error {
  constructor(status, code, meldung, warten) {
    super(code ?? String(status));
    this.status = status;
    this.code = code;
    this.meldung = meldung;
    this.warten = warten;
  }

  // Status 0: Die Anfrage kam gar nicht beim Server an
  get offline() {
    return this.status === 0;
  }
}

// Läuft die Sitzung während der Arbeit ab (401 auf einer Daten-Route), führt die Seite zurück zur Anmeldung
let beiAbgelaufen = () => {};
export function beiSitzungsende(fn) {
  beiAbgelaufen = fn;
}

export async function anfrage(methode, pfad, body) {
  let antwort;
  try {
    antwort = await fetch(pfad, {
      method: methode,
      credentials: "same-origin",
      cache: "no-store",
      // Eine Datei geht unverändert hin (Logo-Upload), alles andere als JSON
      headers:
        body === undefined || body instanceof Blob
          ? undefined
          : { "Content-Type": "application/json" },
      body:
        body === undefined || body instanceof Blob
          ? body
          : JSON.stringify(body),
    });
  } catch {
    throw new ApiFehler(0, "NETZ");
  }
  if (antwort.status === 204) return null;
  let daten = null;
  try {
    daten = await antwort.json();
  } catch {
    // Kein JSON: Der Status genügt
  }
  if (!antwort.ok) {
    if (antwort.status === 401 && pfad.startsWith("/api/v1/")) beiAbgelaufen();
    throw new ApiFehler(
      antwort.status,
      daten?.code,
      daten?.message,
      antwort.headers.get("X-Retry-After"),
    );
  }
  return daten;
}

const CODES = {
  ANMELDUNG_FEHLGESCHLAGEN:
    "Anmeldung nicht möglich. Prüfe Benutzername und Passwort oder versuche es später nochmals.",
  BILD_FORMAT: "Bitte ein Bild als JPEG, PNG oder WebP wählen.",
  PUSH_NICHT_EINGERICHTET:
    "Der Push-Dienst ist auf diesem Server nicht eingerichtet. Es wurde nichts gesendet.",
  NETZ: "Keine Verbindung. Prüfe das Internet und versuche es nochmals.",
  ZWEITER_FAKTOR_FEHLT:
    "Für die Verwaltung braucht es zuerst einen zweiten Faktor. Richte ihn ein und melde dich danach neu an.",
  INVALID_CODE: "Der Code stimmt nicht. Prüfe ihn und versuche es nochmals.",
  INVALID_BACKUP_CODE:
    "Der Ersatzcode stimmt nicht oder wurde schon verwendet.",
  INVALID_TWO_FACTOR_COOKIE:
    "Die Anmeldung ist abgelaufen. Bitte gib Benutzername und Passwort nochmals ein.",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE:
    "Zu viele falsche Codes. Bitte gib Benutzername und Passwort nochmals ein.",
  TOTP_NOT_ENABLED: "Für dieses Konto ist kein zweiter Faktor eingerichtet.",
  BACKUP_CODES_NOT_ENABLED: "Für dieses Konto gibt es keine Ersatzcodes.",
};

// Texte sind Deutsch; Fehlercodes ohne eigenen Text zeigen die Meldung der API nur bei 409 (dort steht sie für Menschen)
export function fehlertext(fehler) {
  if (!(fehler instanceof ApiFehler))
    return "Etwas ist schiefgelaufen. Versuche es nochmals.";
  if (fehler.code && CODES[fehler.code]) return CODES[fehler.code];
  switch (fehler.status) {
    case 400:
      return "Die Eingabe passt nicht. Bitte prüfe die Felder.";
    case 401:
      return "Die Sitzung ist abgelaufen. Bitte melde dich neu an.";
    case 403:
      return "Dafür fehlt die Berechtigung.";
    case 404:
      return "Nicht gefunden. Vielleicht wurde der Eintrag inzwischen geändert oder gelöscht.";
    case 409:
      return (
        fehler.meldung ??
        "Das geht so nicht, weil es mit einem Eintrag kollidiert."
      );
    case 429: {
      const sekunden = Number(fehler.warten);
      const frist =
        sekunden > 0 ? ` in ${Math.ceil(sekunden / 60)} Min.` : " später";
      return `Zu viele Anfragen. Bitte versuche es${frist} nochmals.`;
    }
    case 502:
    case 503:
      return "Der Server antwortet nicht oder wird gerade neu gestartet. Versuche es in ein paar Minuten nochmals.";
    default:
      return "Der Server hat einen Fehler gemeldet. Versuche es nochmals.";
  }
}
