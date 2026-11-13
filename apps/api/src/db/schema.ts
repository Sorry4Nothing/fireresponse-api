import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`);
const bytea = customType<{ data: Uint8Array }>({
  dataType: () => "bytea",
});
const zeitpunkt = (name: string) => timestamp(name, { withTimezone: true });

// Der Kanton Zürich ist fest und keine Tabelle; darunter Bezirk und Einheit (JF oder KF)
export const bezirk = pgTable(
  "bezirk",
  {
    id: id(),
    name: text("name").notNull(),
  },
  (t) => [
    // Ohne Gross-/Kleinschreibung: «Meilen» und «meilen» sind derselbe Bezirk
    uniqueIndex("bezirk_name_eindeutig").on(sql`lower(${t.name})`),
  ],
);

export const einheit = pgTable(
  "einheit",
  {
    id: id(),
    bezirkId: uuid("bezirk_id")
      .notNull()
      .references(() => bezirk.id, { onDelete: "restrict" }),
    typ: text("typ", { enum: ["jf", "kf"] }).notNull(),
    name: text("name").notNull(),
    // AES-GCM-verschlüsselt wie das Startpasswort; nie im Klartext in der Datenbank, nie in Log oder Antwort
    lodurUrlVerschluesselt: text("lodur_url_verschluesselt"),
    // Bezugspunkt für /health, solange der erste Abruf nach dem Eintragen des Links noch aussteht
    lodurUrlGesetztAm: zeitpunkt("lodur_url_gesetzt_am"),
    syncOkAm: zeitpunkt("sync_ok_am"),
    // Nur ein Fehlercode, nie eine Meldung
    syncFehler: text("sync_fehler"),
    // Eigenes Logo (SVG/PNG, vom Server geprüft und bereinigt); beide Spalten gehören zusammen
    logoBild: bytea("logo_bild"),
    logoBildTyp: text("logo_bild_typ"),
  },
  (t) => [
    unique("einheit_bezirk_typ_eindeutig").on(t.bezirkId, t.typ),
    check(
      "einheit_logo_check",
      sql`(${t.logoBild} is null and ${t.logoBildTyp} is null) or (${t.logoBild} is not null and ${t.logoBildTyp} in ('svg', 'png') and octet_length(${t.logoBild}) <= 512000)`,
    ),
    // text({ enum }) prüft nur in TypeScript, nicht in der Datenbank
    check("einheit_typ_check", sql`${t.typ} in ('jf', 'kf')`),
  ],
);

// Tabellen von better-auth: Der Adapter findet sie über den Export-Namen und ihre Spalten über die Eigenschaft, darum genau seine Namen
export const user = pgTable(
  "user",
  {
    id: id(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    // Bleibt leer; better-auth verlangt die Spalte
    image: text("image"),
    createdAt: zeitpunkt("created_at").notNull().defaultNow(),
    updatedAt: zeitpunkt("updated_at").notNull().defaultNow(),
    username: text("username").unique(),
    role: text("role"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: zeitpunkt("ban_expires"),
    twoFactorEnabled: boolean("two_factor_enabled").default(false),
    // Im Zweifel muss die Person das Passwort wechseln
    mussPasswortAendern: boolean("muss_passwort_aendern")
      .notNull()
      .default(true),
    startpasswortGueltigBis: zeitpunkt("startpasswort_gueltig_bis"),
    // AES-GCM-verschlüsselt, nur solange das Startpasswort offen ist; die Verwaltung zeigt es an
    startpasswortVerschluesselt: text("startpasswort_verschluesselt"),
    fehlversuche: integer("fehlversuche").notNull().default(0),
    naechsterVersuchAb: zeitpunkt("naechster_versuch_ab"),
    deaktiviertAm: zeitpunkt("deaktiviert_am"),
    telefon: text("telefon"),
    pushProgramme: boolean("push_programme").notNull().default(true),
    pushAnmeldungen: boolean("push_anmeldungen").notNull().default(true),
    pushInfokanal: boolean("push_infokanal").notNull().default(true),
    // Einwilligung beim ersten Start; ohne gültige Version sperrt die API die App-Routen
    einwilligungAm: zeitpunkt("einwilligung_am"),
    einwilligungVersion: integer("einwilligung_version"),
  },
  (t) => [
    // Gespeichert wird kleingeschrieben; die Regel gilt in der Datenbank wie an der Route
    check(
      "user_username_regel",
      sql`${t.username} is null or (${t.username} ~ '^[A-Za-z0-9._-]{3,64}$' and ${t.username} = lower(${t.username}))`,
    ),
    check(
      "user_einwilligung_zusammen",
      sql`(${t.einwilligungAm} is null) = (${t.einwilligungVersion} is null)`,
    ),
  ],
);

export const session = pgTable(
  "session",
  {
    id: id(),
    expiresAt: zeitpunkt("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: zeitpunkt("created_at").notNull().defaultNow(),
    updatedAt: zeitpunkt("updated_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Bleibt leer, es gibt keine Identitätsübernahme; better-auth verlangt die Spalte
    impersonatedBy: text("impersonated_by"),
  },
  (t) => [
    index("session_user_id_idx").on(t.userId),
    // better-auth verlangt beide Spalten; der Hook in auth.ts leert sie, und die Datenbank lehnt jeden Wert ab
    check(
      "session_ohne_ip_und_user_agent",
      sql`${t.ipAddress} is null and ${t.userAgent} is null`,
    ),
  ],
);

export const account = pgTable(
  "account",
  {
    id: id(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: zeitpunkt("access_token_expires_at"),
    refreshTokenExpiresAt: zeitpunkt("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: zeitpunkt("created_at").notNull().defaultNow(),
    updatedAt: zeitpunkt("updated_at").notNull(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: id(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: zeitpunkt("expires_at").notNull(),
    createdAt: zeitpunkt("created_at").notNull().defaultNow(),
    updatedAt: zeitpunkt("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const rateLimit = pgTable("rate_limit", {
  id: id(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  // Ohne Standardwert: Das Rate-Limit schreibt die Zeit immer selbst
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const twoFactor = pgTable(
  "two_factor",
  {
    id: id(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    // better-auth setzt hier keine Löschregel; ohne CASCADE scheitert das Löschen einer Person mit zweitem Faktor
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: zeitpunkt("locked_until"),
  },
  (t) => [
    index("two_factor_secret_idx").on(t.secret),
    index("two_factor_user_id_idx").on(t.userId),
  ],
);

export const rang = pgTable(
  "rang",
  {
    id: id(),
    einheitId: uuid("einheit_id")
      .notNull()
      .references(() => einheit.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    kuerzel: text("kuerzel").notNull(),
    // Kinderfeuerwehr, Jugendfeuerwehr oder Miliz-Feuerwehr; der Standard gilt nur für Einfügen ohne Angabe, der Code setzt den Typ der Einheit
    typ: text("typ", { enum: ["kf", "jf", "miliz"] })
      .notNull()
      .default("jf"),
    reihenfolge: integer("reihenfolge").notNull(),
    // Abzeichen: 0 bis 5 Sterne oder ein eigenes Bild (SVG/PNG, vom Server geprüft); höchstens eines von beiden
    abzeichenSterne: integer("abzeichen_sterne"),
    abzeichenBild: bytea("abzeichen_bild"),
    abzeichenBildTyp: text("abzeichen_bild_typ"),
  },
  (t) => [
    // Jeder Typ hat seine eigene Hierarchie: die Reihenfolge gilt je Einheit und Typ
    unique("rang_reihenfolge_pro_einheit").on(
      t.einheitId,
      t.typ,
      t.reihenfolge,
    ),
    // Ziel des zusammengesetzten Fremdschlüssels: Ein Rang gehört genau einer Einheit
    unique("rang_id_einheit").on(t.id, t.einheitId),
    check("rang_reihenfolge_check", sql`${t.reihenfolge} between 1 and 999`),
    check("rang_typ_check", sql`${t.typ} in ('kf', 'jf', 'miliz')`),
    check(
      "rang_sterne_check",
      sql`${t.abzeichenSterne} is null or ${t.abzeichenSterne} between 0 and 5`,
    ),
    check(
      "rang_abzeichen_eines",
      sql`not (${t.abzeichenSterne} is not null and ${t.abzeichenBild} is not null)`,
    ),
    check(
      "rang_bild_typ_check",
      sql`(${t.abzeichenBild} is null and ${t.abzeichenBildTyp} is null) or (${t.abzeichenBild} is not null and ${t.abzeichenBildTyp} in ('svg', 'png') and octet_length(${t.abzeichenBild}) <= 512000)`,
    ),
  ],
);

// Das Kommando einer Einheit und ihre Leitenden. Genau eine Kommandantin oder ein Kommandant: den Rest sichert der Code (Anlegen und Übergabe in einer Transaktion)
export const einheitRolle = pgTable(
  "einheit_rolle",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    einheitId: uuid("einheit_id")
      .notNull()
      .references(() => einheit.id, { onDelete: "restrict" }),
    typ: text("typ", {
      enum: ["kommandant", "stellvertretung", "leitung"],
    }).notNull(),
    // Nur bei Stellvertretungen: 1 = erste Ansprechperson nach dem Kommandanten
    reihenfolge: integer("reihenfolge"),
    rangId: uuid("rang_id"),
    erstelltAm: zeitpunkt("erstellt_am").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.einheitId] }),
    foreignKey({
      columns: [t.rangId, t.einheitId],
      foreignColumns: [rang.id, rang.einheitId],
      name: "einheit_rolle_rang_der_einheit",
    }).onDelete("restrict"),
    // Höchstens ein Kommandant pro Einheit
    uniqueIndex("einheit_rolle_ein_kommandant")
      .on(t.einheitId)
      .where(sql`${t.typ} = 'kommandant'`),
    unique("einheit_rolle_reihenfolge_eindeutig").on(
      t.einheitId,
      t.reihenfolge,
    ),
    index("einheit_rolle_einheit_idx").on(t.einheitId),
    check(
      "einheit_rolle_typ_check",
      sql`${t.typ} in ('kommandant', 'stellvertretung', 'leitung')`,
    ),
    // Reihenfolge genau bei Stellvertretungen
    check(
      "einheit_rolle_reihenfolge_check",
      sql`(${t.typ} = 'stellvertretung' and ${t.reihenfolge} is not null and ${t.reihenfolge} >= 1) or (${t.typ} <> 'stellvertretung' and ${t.reihenfolge} is null)`,
    ),
  ],
);

export const teilnehmende = pgTable(
  "teilnehmende",
  {
    id: id(),
    einheitId: uuid("einheit_id")
      .notNull()
      .references(() => einheit.id, { onDelete: "restrict" }),
    vorname: text("vorname").notNull(),
    nachname: text("nachname").notNull(),
    rangId: uuid("rang_id"),
    // Ohne Datum ist die Person aktiv
    inaktivSeit: zeitpunkt("inaktiv_seit"),
  },
  (t) => [
    foreignKey({
      columns: [t.rangId, t.einheitId],
      foreignColumns: [rang.id, rang.einheitId],
      name: "teilnehmende_rang_der_einheit",
    }).onDelete("restrict"),
    index("teilnehmende_einheit_idx").on(t.einheitId),
  ],
);

// Pro Teilnehmende/r antworten entweder die Eltern oder das Kind selbst, nie beide: Der Code prüft es in der Transaktion, die Datenbank sichert höchstens ein eigenes Konto
export const teilnehmendeKonto = pgTable(
  "teilnehmende_konto",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teilnehmendeId: uuid("teilnehmende_id")
      .notNull()
      .references(() => teilnehmende.id, { onDelete: "cascade" }),
    art: text("art", { enum: ["eltern", "selbst"] }).notNull(),
    erstelltAm: zeitpunkt("erstellt_am").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.teilnehmendeId] }),
    uniqueIndex("teilnehmende_konto_ein_selbst")
      .on(t.teilnehmendeId)
      .where(sql`${t.art} = 'selbst'`),
    index("teilnehmende_konto_teilnehmende_idx").on(t.teilnehmendeId),
    check(
      "teilnehmende_konto_art_check",
      sql`${t.art} in ('eltern', 'selbst')`,
    ),
  ],
);

// Ein Termin aus dem Lodur-Kalender der Einheit. shortcut: Tabelle und Spalte google_event_id behalten ihre Namen aus der Planung vor Lodur, die Spalte trägt die Lodur-UID; Umbenennung zusammen mit programm -> termin
export const programm = pgTable(
  "programm",
  {
    id: id(),
    einheitId: uuid("einheit_id")
      .notNull()
      .references(() => einheit.id, { onDelete: "restrict" }),
    // Woher der Termin kommt: «lodur» gehört dem Sync, «manuell» legt die Verwaltung an und der Sync fasst ihn nie an. Weitere Angaben zu manuellen Terminen (z. B. eine Höchstzahl) kommen als eigene Spalten dazu
    quelle: text("quelle", { enum: ["lodur", "manuell"] })
      .notNull()
      .default("lodur"),
    // Bei manuellen Terminen «manuell-<uuid>»: nur damit die Eindeutigkeit je Einheit gilt
    googleEventId: text("google_event_id").notNull(),
    // Roher recurringEventId; der Sync (E3) kürzt den Stamm (_R…) erst beim Suchen
    googleSerie: text("google_serie"),
    titel: text("titel").notNull(),
    ganztaegig: boolean("ganztaegig").notNull(),
    beginn: zeitpunkt("beginn"),
    ende: zeitpunkt("ende"),
    tagVon: date("tag_von"),
    // Googles Enddatum ist exklusiv; hier steht der letzte Programmtag
    tagBis: date("tag_bis"),
    googleOrt: text("google_ort"),
    // Aus dem HTML der Google-Beschreibung; gilt als intern
    googleBeschreibung: text("google_beschreibung"),
    // «Thema/Dienst», «Info» und «Aufgebot» aus der Lodur-Beschreibung (Sync); «Verantwortlich» wird nie gespeichert. Leer, solange die Quelle sie nicht liefert
    thema: text("thema"),
    info: text("info"),
    aufgebot: text("aufgebot"),
    // Spalte «Art» der Lodur-Tabelle (Sitzung, Übung, Kurs, Anlass …); null, solange die Quelle sie nicht liefert
    art: text("art"),
    // Gehört der Verwaltung, nie dem Sync: true zeigt den Termin Kindern und Eltern weder in der App noch in Push und Erinnerungen
    nurLeitende: boolean("nur_leitende").notNull().default(false),
    // Höchstzahl der Zusagen von Leitenden (Kommando, Stellvertretung, Leitung); null heisst ohne Grenze. Nur bei manuellen Terminen; weitere Zusagen kommen auf die Warteliste
    leitungHoechstzahl: integer("leitung_hoechstzahl"),
    status: text("status", { enum: ["aktiv", "abgesagt", "pruefen"] })
      .notNull()
      .default("aktiv"),
    // SHA-256 über die Felder, die der Sync übernimmt: CREATED, DTSTAMP und LAST-MODIFIED sind in Lodur immer der Abrufzeitpunkt
    inhaltHash: text("inhalt_hash"),
  },
  (t) => [
    unique("programm_einheit_google_event_eindeutig").on(
      t.einheitId,
      t.googleEventId,
    ),
    check("programm_quelle_check", sql`${t.quelle} in ('lodur', 'manuell')`),
    check(
      "programm_leitung_hoechstzahl_check",
      sql`${t.leitungHoechstzahl} is null or (${t.leitungHoechstzahl} >= 1 and ${t.quelle} = 'manuell')`,
    ),
    check(
      "programm_status_check",
      sql`${t.status} in ('aktiv', 'abgesagt', 'pruefen')`,
    ),
    // Ganztägig genau dann, wenn Tage gesetzt und Zeitpunkte leer sind
    check(
      "programm_zeiten_passen_zu_ganztaegig",
      sql`(${t.ganztaegig} and ${t.tagVon} is not null and ${t.tagBis} is not null and ${t.beginn} is null and ${t.ende} is null) or (not ${t.ganztaegig} and ${t.beginn} is not null and ${t.ende} is not null and ${t.tagVon} is null and ${t.tagBis} is null)`,
    ),
  ],
);

// Ohne Zeile gilt «offen»; wer nicht antwortet, sagt damit nicht ab
export const teilnahme = pgTable(
  "teilnahme",
  {
    programmId: uuid("programm_id")
      .notNull()
      .references(() => programm.id, { onDelete: "cascade" }),
    teilnehmendeId: uuid("teilnehmende_id")
      .notNull()
      .references(() => teilnehmende.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["ja", "nein"] }).notNull(),
    geaendertVon: uuid("geaendert_von").references(() => user.id, {
      onDelete: "set null",
    }),
    geaendertAm: zeitpunkt("geaendert_am").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.programmId, t.teilnehmendeId] }),
    // text({ enum }) prüft nur in TypeScript, nicht in der Datenbank
    check("teilnahme_status_check", sql`${t.status} in ('ja', 'nein')`),
  ],
);

// Keine Zeile heisst «offen»; dass die Person Kommando oder Leitung der Einheit des Programms ist, prüft die Route. «warteliste»: Die Zusage fand wegen der Höchstzahl des Programms keinen Platz
export const leitungAnmeldung = pgTable(
  "leitung_anmeldung",
  {
    programmId: uuid("programm_id")
      .notNull()
      .references(() => programm.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["ja", "nein", "warteliste"] }).notNull(),
    // Nur bei «warteliste»: Zeitpunkt der Eintragung, danach richtet sich die Reihenfolge
    wartelisteSeit: zeitpunkt("warteliste_seit"),
  },
  (t) => [
    primaryKey({ columns: [t.programmId, t.userId] }),
    // text({ enum }) prüft nur in TypeScript, nicht in der Datenbank
    check(
      "leitung_anmeldung_status_check",
      sql`${t.status} in ('ja', 'nein', 'warteliste')`,
    ),
    check(
      "leitung_anmeldung_warteliste_check",
      sql`(${t.status} = 'warteliste') = (${t.wartelisteSeit} is not null)`,
    ),
  ],
);

// Ein Token pro Sitzung; endet die Sitzung (Abmelden, überall abmelden, Deaktivieren, Konto löschen, täglicher Job), nimmt CASCADE das Token mit
export const pushToken = pgTable(
  "push_token",
  {
    sessionId: uuid("session_id")
      .primaryKey()
      .references(() => session.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    plattform: text("plattform", { enum: ["ios", "android"] }).notNull(),
    zuletztGesehen: zeitpunkt("zuletzt_gesehen").notNull().defaultNow(),
  },
  (t) => [
    // text({ enum }) prüft nur in TypeScript, nicht in der Datenbank
    check(
      "push_token_plattform_check",
      sql`${t.plattform} in ('ios', 'android')`,
    ),
  ],
);

// Erinnerung an Personen ohne Antwort, pro Einheit. Abstand zum Termin: tageVorher Kalendertage (0 bis 7) vor dem Tag des Beginns, zur Uhrzeit HH:mm Schweizer Zeit
export const zeitregel = pgTable(
  "zeitregel",
  {
    id: id(),
    einheitId: uuid("einheit_id")
      .notNull()
      .references(() => einheit.id, { onDelete: "restrict" }),
    tageVorher: integer("tage_vorher").notNull(),
    uhrzeit: text("uhrzeit").notNull(),
    // Der Push-Titel; {Programm} und {Datum} ersetzt der Server
    text: text("text").notNull(),
    // Der Text unter dem Titel; leer heisst: der Push hat keinen
    beschreibung: text("beschreibung"),
    aktiv: boolean("aktiv").notNull().default(true),
    erstelltAm: zeitpunkt("erstellt_am").notNull().defaultNow(),
  },
  (t) => [
    check("zeitregel_tage_vorher_check", sql`${t.tageVorher} between 0 and 7`),
    check(
      "zeitregel_uhrzeit_check",
      sql`${t.uhrzeit} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
  ],
);

// Eine Zeile pro gesendeter Erinnerung; sie entsteht vor dem Versand und ist die Sperre gegen Doppelsendung
export const zeitregelGesendet = pgTable(
  "zeitregel_gesendet",
  {
    regelId: uuid("regel_id")
      .notNull()
      .references(() => zeitregel.id, { onDelete: "cascade" }),
    programmId: uuid("programm_id")
      .notNull()
      .references(() => programm.id, { onDelete: "cascade" }),
    gesendetAm: zeitpunkt("gesendet_am").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.regelId, t.programmId] })],
);

// Wartungsmodus: genau eine Zeile (feste ID). Aus heisst: text, ende und seit sind leer
export const WARTUNG_ID = "00000000-0000-4000-8000-000000000001";
export const wartung = pgTable(
  "wartung",
  {
    id: uuid("id").primaryKey(),
    aktiv: boolean("aktiv").notNull().default(false),
    // Eigener Text für die App; leer heisst: Standardtext der App
    text: text("text"),
    // Voraussichtliches Ende, nur zur Anzeige: Es beendet die Wartung nicht von selbst
    ende: zeitpunkt("ende"),
    seit: zeitpunkt("seit"),
  },
  (t) => [
    check("wartung_einzeln", sql`${t.id} = ${sql.raw(`'${WARTUNG_ID}'`)}`),
    check("wartung_text_kurz", sql`char_length(${t.text}) <= 280`),
    check(
      "wartung_aus_leer",
      sql`${t.aktiv} or (${t.text} is null and ${t.ende} is null and ${t.seit} is null)`,
    ),
    check("wartung_an_seit", sql`not ${t.aktiv} or ${t.seit} is not null`),
  ],
);

// akteur_id und ziel_id ohne Fremdschlüssel, damit das Log Löschungen übersteht
export const auditLog = pgTable("audit_log", {
  id: id(),
  // Leer bei Aktionen, die keine Einheit betreffen (Bezirke, Kantonsadmin). Ohne Fremdschlüssel, damit das Log das Löschen der Einheit übersteht
  einheitId: uuid("einheit_id"),
  // UUID einer Person oder «cli» für die Kommandozeile, die kein Konto hat
  akteurId: text("akteur_id").notNull(),
  aktion: text("aktion").notNull(),
  zielTyp: text("ziel_typ").notNull(),
  zielId: uuid("ziel_id").notNull(),
  // Ohne Personendaten
  details: jsonb("details"),
  erstelltAm: zeitpunkt("erstellt_am").notNull().defaultNow(),
});

// Das Profilbild einer Person: höchstens eines, vom Server auf 256 × 256 JPEG neu kodiert; die Zeile geht mit dem Konto
export const profilbild = pgTable(
  "profilbild",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    inhalt: bytea("inhalt").notNull(),
    geaendertAm: zeitpunkt("geaendert_am").notNull().defaultNow(),
  },
  (t) => [
    // Die Route kodiert auf rund 20 KB; die Grenze fängt einen Fehler im Code ab, bevor die Tabelle wächst
    check("profilbild_inhalt_klein", sql`octet_length(${t.inhalt}) <= 262144`),
  ],
);

// Eine Mitteilung im Infokanal einer Einheit (Einwegkanal: schreiben nur Kommando und Leitung). Gelöscht heisst: Text und Autor sind in der Datenbank weg, die Zeile bleibt als Platzhalter bis zur automatischen Löschung nach 6 Monaten. Ohne Autor, aber nicht gelöscht: Das Konto des Autors ist gelöscht, der Text bleibt
export const infokanalMitteilung = pgTable(
  "infokanal_mitteilung",
  {
    id: id(),
    // RESTRICT wie überall bei der Einheit; das Löschen einer leeren Einheit entfernt ihre Mitteilungen zuvor selbst (routes/admin/einheiten.ts)
    einheitId: uuid("einheit_id")
      .notNull()
      .references(() => einheit.id, { onDelete: "restrict" }),
    autorId: uuid("autor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    text: text("text"),
    bearbeitetAm: zeitpunkt("bearbeitet_am"),
    geloeschtAm: zeitpunkt("geloescht_am"),
    erstelltAm: zeitpunkt("erstellt_am").notNull().defaultNow(),
  },
  (t) => [
    // Die Liste läuft je Einheit nach id (uuidv7, also nach Zeit)
    index("infokanal_mitteilung_einheit_idx").on(t.einheitId, t.id),
    index("infokanal_mitteilung_erstellt_idx").on(t.erstelltAm),
    index("infokanal_mitteilung_autor_idx").on(t.autorId),
    // Text genau dann, wenn nicht gelöscht; ein gelöschter Eintrag hat auch keinen Autor mehr
    check(
      "infokanal_mitteilung_text_check",
      sql`(${t.geloeschtAm} is null and ${t.text} is not null and char_length(${t.text}) between 1 and 2000) or (${t.geloeschtAm} is not null and ${t.text} is null and ${t.autorId} is null)`,
    ),
  ],
);

// Bis wann ein Konto den Infokanal einer Einheit gelesen hat; ohne Zeile ist alles ungelesen
export const infokanalGelesen = pgTable(
  "infokanal_gelesen",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    einheitId: uuid("einheit_id")
      .notNull()
      .references(() => einheit.id, { onDelete: "restrict" }),
    gelesenBis: zeitpunkt("gelesen_bis").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.einheitId] })],
);

// Eine Mitteilung des Kantonsadmins an die Konten der Verwaltung (Glocke im Panel), nur Text und ohne Personendaten. Sie läuft nach laeuft_ab_am aus der Glocke; die API löscht sie 6 Monate danach, ohne Ablauf 6 Monate nach dem Erstellen
export const nachricht = pgTable(
  "nachricht",
  {
    id: id(),
    titel: text("titel").notNull(),
    text: text("text").notNull(),
    laeuftAbAm: zeitpunkt("laeuft_ab_am"),
    erstelltAm: zeitpunkt("erstellt_am").notNull().defaultNow(),
  },
  (t) => [
    check(
      "nachricht_titel_check",
      sql`char_length(${t.titel}) between 1 and 80`,
    ),
    check(
      "nachricht_text_check",
      sql`char_length(${t.text}) between 1 and 1000`,
    ),
  ],
);

// Wer eine Mitteilung gelesen hat; der Kantonsadmin sieht nur die Zahl, nie die Konten
export const nachrichtGelesen = pgTable(
  "nachricht_gelesen",
  {
    nachrichtId: uuid("nachricht_id")
      .notNull()
      .references(() => nachricht.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    gelesenAm: zeitpunkt("gelesen_am").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.nachrichtId, t.userId] })],
);
