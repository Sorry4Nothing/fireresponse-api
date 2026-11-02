// Welche Daten FireResponse bearbeitet: jede Spalte der Datenbank mit ihrer Kategorie, dazu Zweck und Frist je Kategorie.
// Ein Test hält diese Datei und das Drizzle-Schema zusammen (test/datenkategorien.test.ts).
// Die Angaben für Apple «App Privacy» und Google «Data safety» stammen aus derselben Datei; sie sind ein Vorschlag und werden vor dem Store-Eintrag gegen die aktuellen Formulare geprüft.

export type Kategorie = {
  titel: string;
  zweck: string;
  frist: string;
  // Datentypen der Formulare der Stores; leer heisst: keine Personendaten im Sinne des Formulars
  apple: string[];
  google: string[];
};

const AUF_ANFRAGE = "Auf Anfrage löscht die Leitung Daten.";

export const KATEGORIEN = {
  konto: {
    titel: "Konto und Anmeldung",
    zweck:
      "Anmelden, Rechte prüfen und das Konto vor Missbrauch schützen. Dazu gehört das Passwort, das nur als Prüfwert gespeichert ist.",
    frist: `Bis das Konto gelöscht wird. ${AUF_ANFRAGE}`,
    apple: ["Contact Info: Name", "Identifiers: User ID"],
    google: ["Personal info: Name", "Personal info: User IDs"],
  },
  telefon: {
    titel: "Telefonnummer des Kommandos",
    zweck:
      "Eltern und Teilnehmende erreichen das Kommando ihrer Einheit. Die Nummer ist freiwillig.",
    frist: "Bis die Person die Nummer entfernt oder das Konto gelöscht wird.",
    apple: ["Contact Info: Phone Number"],
    google: ["Personal info: Phone number"],
  },
  profilbild: {
    titel: "Profilbild",
    zweck:
      "Andere Personen erkennen, wen sie erreichen. Das Bild ist freiwillig, und jede Person lädt nur ihr eigenes hoch.",
    frist:
      "Bis die Person das Bild löscht oder das Konto deaktiviert oder gelöscht wird. Teilnehmende ohne eigenes Konto haben kein Bild.",
    apple: ["User Content: Photos or Videos"],
    google: ["Photos and videos: Photos"],
  },
  teilnehmende: {
    titel: "Teilnehmende",
    zweck:
      "Die Eltern oder die Teilnehmenden selbst melden sich zu Programmen an oder ab, und das Kommando sieht, wer kommt.",
    frist: `Bis das Kommando den Eintrag löscht. ${AUF_ANFRAGE}`,
    apple: ["Contact Info: Name"],
    google: ["Personal info: Name"],
  },
  rollen: {
    titel: "Rollen in den Einheiten",
    zweck: "Festlegen, wer welche Programme und Anmeldungen sehen darf.",
    frist: "Bis das Kommando die Rolle entfernt oder das Konto gelöscht wird.",
    apple: ["Other Data"],
    google: ["Personal info: Other info"],
  },
  programme: {
    titel: "Programme",
    zweck:
      "Information über Zeit und Thema der Programme (Titel, Zeit, Thema, Info, Aufgebot). Sie stammen aus dem Lodur-Kalender der Einheit: Die API ruft ihn alle 15 Minuten ab und gleicht Änderungen und Absagen ab. Der Eintrag Verantwortlich wird nie gespeichert.",
    frist:
      "Bis die Leitung das Programm löscht. Der Kalender der Einheit bleibt unverändert; entfernt das Kommando den Link, bleiben die Programme, es kommen keine neuen.",
    apple: [],
    google: [],
  },
  anmeldungen: {
    titel: "Anmeldungen und Abmeldungen",
    zweck:
      "Zeigen, ob eine teilnehmende Person zu einem Programm kommt (Ja oder Nein) und ob eine Leitungsperson dabei ist. Die Verwaltung wertet die Anmeldungen aus: Teilnahmequote pro Person und Jahresübersicht pro Einheit.",
    frist: `Bis das Kommando die Anmeldung, die teilnehmende Person oder das Programm löscht. ${AUF_ANFRAGE}`,
    apple: ["Other Data"],
    google: ["App activity: Other actions"],
  },
  benachrichtigungen: {
    titel: "Benachrichtigungen",
    zweck:
      "Pushes zu Programmen, zu An- und Abmeldungen und zu Erinnerungen zustellen. Das Token gehört zum Gerät und zur Sitzung.",
    frist:
      "Bis die Sitzung endet, also beim Abmelden, beim Deaktivieren und beim Löschen des Kontos.",
    apple: ["Identifiers: Device ID"],
    google: ["Device or other IDs"],
  },
  technik: {
    titel: "Technische Daten",
    zweck:
      "Sitzungen führen, Anfragen begrenzen und Fehler finden. Dazu gehören IP-Adressen in den Logs und für die Begrenzung.",
    frist:
      "Logs 14 Tage. Die Begrenzung der Anfragen löscht ihre Einträge frühestens 15 Minuten nach der letzten Anfrage. Sitzungen enden nach 90 Tagen ohne Nutzung oder früher mit dem Abmelden.",
    apple: ["Diagnostics: Other Diagnostic Data"],
    google: ["App info and performance: Diagnostics"],
  },
  protokoll: {
    titel: "Protokoll der Verwaltung",
    zweck:
      "Nachvollziehen, welche Verwaltungsaktion wann auf wen oder was zielte. Das Protokoll enthält Kennungen, keine Namen.",
    frist: "Das Protokoll bleibt; es enthält keine Personendaten.",
    apple: [],
    google: [],
  },
  einheiten: {
    titel: "Angaben der Bezirke und Einheiten",
    zweck:
      "Der Bezirk, die Einheit (Jugend- oder Kinderfeuerwehr), ihre Ränge mit Abzeichen und der Link zum Lodur-Kalender mit dem Stand des Abrufs (Zeitpunkt des letzten Erfolgs, Fehlercode). Der Link ist verschlüsselt gespeichert und kommt nie in eine Antwort; die API ruft nur Hosts von der Liste des Betreibers ab.",
    frist:
      "Bis das Kommando die Angaben ändert oder löscht. Entfernt das Kommando den Link, löscht die API ihn mit dem Stand des Abrufs.",
    apple: [],
    google: [],
  },
} satisfies Record<string, Kategorie>;

export type KategorieId = keyof typeof KATEGORIEN;

// Tabelle -> Kategorie -> Spalten. Jede Spalte steht genau einmal da; ein Test scheitert bei einer neuen oder entfernten Spalte
export const SPALTEN: Record<string, Partial<Record<KategorieId, string[]>>> = {
  account: {
    konto: [
      "id",
      "account_id",
      "provider_id",
      "user_id",
      "access_token",
      "refresh_token",
      "id_token",
      "access_token_expires_at",
      "refresh_token_expires_at",
      "scope",
      "password",
      "created_at",
      "updated_at",
    ],
  },
  audit_log: {
    protokoll: [
      "id",
      "einheit_id",
      "akteur_id",
      "aktion",
      "ziel_typ",
      "ziel_id",
      "details",
      "erstellt_am",
    ],
  },
  bezirk: { einheiten: ["id", "name"] },
  einheit: {
    einheiten: [
      "id",
      "bezirk_id",
      "typ",
      "name",
      "lodur_url_verschluesselt",
      "lodur_url_gesetzt_am",
      "sync_ok_am",
      "sync_fehler",
      "anmelde_arten",
      "logo_bild",
      "logo_bild_typ",
    ],
  },
  einheit_rolle: {
    rollen: [
      "user_id",
      "einheit_id",
      "typ",
      "reihenfolge",
      "rang_id",
      "erstellt_am",
    ],
  },
  leitung_anmeldung: {
    anmeldungen: ["programm_id", "user_id", "status"],
  },
  programm: {
    programme: [
      "id",
      "einheit_id",
      "google_event_id",
      "google_serie",
      "titel",
      "ganztaegig",
      "beginn",
      "ende",
      "tag_von",
      "tag_bis",
      "google_ort",
      "google_beschreibung",
      "thema",
      "info",
      "aufgebot",
      "art",
      "status",
      "inhalt_hash",
    ],
  },
  profilbild: { profilbild: ["user_id", "inhalt", "geaendert_am"] },
  push_token: {
    benachrichtigungen: [
      "session_id",
      "token",
      "user_id",
      "plattform",
      "zuletzt_gesehen",
    ],
  },
  rate_limit: { technik: ["id", "key", "count", "last_request"] },
  rang: {
    einheiten: [
      "id",
      "einheit_id",
      "name",
      "kuerzel",
      "reihenfolge",
      "abzeichen_sterne",
      "abzeichen_bild",
      "abzeichen_bild_typ",
    ],
  },
  session: {
    technik: [
      "id",
      "expires_at",
      "token",
      "created_at",
      "updated_at",
      "ip_address",
      "user_agent",
      "user_id",
      "impersonated_by",
    ],
  },
  teilnahme: {
    anmeldungen: [
      "programm_id",
      "teilnehmende_id",
      "status",
      "geaendert_von",
      "geaendert_am",
    ],
  },
  teilnehmende: {
    teilnehmende: [
      "id",
      "einheit_id",
      "vorname",
      "nachname",
      "rang_id",
      "inaktiv_seit",
    ],
  },
  teilnehmende_konto: {
    teilnehmende: ["user_id", "teilnehmende_id", "art", "erstellt_am"],
  },
  two_factor: {
    konto: [
      "id",
      "secret",
      "backup_codes",
      "user_id",
      "verified",
      "failed_verification_count",
      "locked_until",
    ],
  },
  user: {
    konto: [
      "id",
      "name",
      "email",
      "email_verified",
      "image",
      "created_at",
      "updated_at",
      "username",
      "role",
      "banned",
      "ban_reason",
      "ban_expires",
      "two_factor_enabled",
      "muss_passwort_aendern",
      "startpasswort_gueltig_bis",
      "startpasswort_verschluesselt",
      "fehlversuche",
      "naechster_versuch_ab",
      "deaktiviert_am",
      "einwilligung_am",
      "einwilligung_version",
    ],
    telefon: ["telefon"],
    benachrichtigungen: ["push_programme", "push_anmeldungen"],
  },
  verification: {
    technik: [
      "id",
      "identifier",
      "value",
      "expires_at",
      "created_at",
      "updated_at",
    ],
  },
  zeitregel: {
    benachrichtigungen: [
      "id",
      "einheit_id",
      "wochentag",
      "uhrzeit",
      "text",
      "beschreibung",
      "aktiv",
      "erstellt_am",
    ],
  },
  zeitregel_gesendet: {
    benachrichtigungen: ["regel_id", "programm_id", "gesendet_am"],
  },
};

// Was die Apps auf dem Gerät ablegen (Schlüssel im geschützten Speicher des Systems) -> Kategorie. Die Apps liegen in eigenen Repos; wer dort einen Schlüssel ergänzt, ergänzt ihn auch hier
export const GERAET: Record<string, KategorieId> = {
  sitzung: "konto",
};

// Gilt für beide Stores, unabhängig von der Kategorie
export const STORE_ALLGEMEIN = {
  tracking: false,
  werbung: false,
  analyse: false,
  // Pushes tragen keine Kindernamen, nur den Namen eines Programms
  weitergabeAn: ["Apple (Push)", "Google (Push)"],
  verschluesselteUebertragung: true,
  loeschungMoeglich: true,
};
