import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
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

export const abteilung = pgTable("abteilung", {
  id: id(),
  name: text("name").notNull(),
});

// Tabellen von better-auth: Der Adapter findet sie über den Export-Namen und ihre Spalten über die Eigenschaft, darum genau seine Namen
export const user = pgTable("user", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  // Bleibt leer; better-auth verlangt die Spalte
  image: text("image"),
  createdAt: zeitpunkt("created_at").notNull().defaultNow(),
  updatedAt: zeitpunkt("updated_at").notNull().defaultNow(),
  username: text("username").unique(),
  displayUsername: text("display_username"),
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: zeitpunkt("ban_expires"),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  abteilungId: uuid("abteilung_id")
    .notNull()
    .references(() => abteilung.id, { onDelete: "restrict" }),
  // Im Zweifel muss die Person das Passwort wechseln
  mussPasswortAendern: boolean("muss_passwort_aendern").notNull().default(true),
  startpasswortGueltigBis: zeitpunkt("startpasswort_gueltig_bis"),
  // AES-GCM-verschlüsselt, nur solange das Startpasswort offen ist; die Verwaltung zeigt es an
  startpasswortVerschluesselt: text("startpasswort_verschluesselt"),
  fehlversuche: integer("fehlversuche").notNull().default(0),
  naechsterVersuchAb: zeitpunkt("naechster_versuch_ab"),
  deaktiviertAm: zeitpunkt("deaktiviert_am"),
  telefon: text("telefon"),
  pushProgramme: boolean("push_programme").notNull().default(true),
  pushAnmeldungen: boolean("push_anmeldungen").notNull().default(true),
  datenschutzGelesenAm: zeitpunkt("datenschutz_gelesen_am"),
});

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

// Löschbar nur ohne Kinder und Leitung: Die Fremdschlüssel sind RESTRICT, die API-Rolle hat DELETE seit Migration 0023
export const stufe = pgTable(
  "stufe",
  {
    id: id(),
    abteilungId: uuid("abteilung_id")
      .notNull()
      .references(() => abteilung.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    kuerzel: text("kuerzel").notNull(),
  },
  (t) => [
    // Ohne Gross-/Kleinschreibung: «Biber» und «biber» sind dieselbe Stufe
    uniqueIndex("stufe_name_pro_abteilung").on(
      t.abteilungId,
      sql`lower(${t.name})`,
    ),
  ],
);

// Dass Person, Kind und Stufe zur selben Abteilung gehören, prüfen die Routen, nicht die Datenbank
export const rolle = pgTable(
  "rolle",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    stufeId: uuid("stufe_id")
      .notNull()
      .references(() => stufe.id, { onDelete: "restrict" }),
    typ: text("typ", { enum: ["leitung", "stufenleitung"] }).notNull(),
    // Reihenfolge der SL einer Stufe in den Kontakten: 1 = erster Ansprechpartner; null = nicht eingereiht, steht hinter den anderen
    prioritaet: integer("prioritaet"),
    erstelltAm: zeitpunkt("erstellt_am").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.stufeId] }),
    check("rolle_prioritaet_check", sql`${t.prioritaet} >= 1`),
    // text({ enum }) prüft nur in TypeScript, nicht in der Datenbank
    check("rolle_typ_check", sql`${t.typ} in ('leitung', 'stufenleitung')`),
  ],
);

export const kind = pgTable("kind", {
  id: id(),
  abteilungId: uuid("abteilung_id")
    .notNull()
    .references(() => abteilung.id, { onDelete: "restrict" }),
  vorname: text("vorname").notNull(),
  nachname: text("nachname").notNull(),
  stufeId: uuid("stufe_id")
    .notNull()
    .references(() => stufe.id, { onDelete: "restrict" }),
  stufeSeit: zeitpunkt("stufe_seit").notNull().defaultNow(),
  // Ohne Datum ist das Kind aktiv
  inaktivSeit: zeitpunkt("inaktiv_seit"),
});

export const kindEltern = pgTable(
  "kind_eltern",
  {
    kindId: uuid("kind_id")
      .notNull()
      .references(() => kind.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    erstelltAm: zeitpunkt("erstellt_am").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.kindId, t.userId] })],
);

export const programm = pgTable(
  "programm",
  {
    id: id(),
    abteilungId: uuid("abteilung_id")
      .notNull()
      .references(() => abteilung.id, { onDelete: "restrict" }),
    googleEventId: text("google_event_id").notNull(),
    // Roher recurringEventId; #28 kürzt den Stamm (_R…) erst beim Suchen
    googleSerie: text("google_serie"),
    titel: text("titel").notNull(),
    ganztaegig: boolean("ganztaegig").notNull(),
    beginn: zeitpunkt("beginn"),
    ende: zeitpunkt("ende"),
    tagVon: date("tag_von"),
    // Googles Enddatum ist exklusiv; hier steht der letzte Programmtag
    tagBis: date("tag_bis"),
    googleOrt: text("google_ort"),
    // Aus dem HTML der Google-Beschreibung; gilt als intern, Eltern sehen sie nie
    googleBeschreibung: text("google_beschreibung"),
    status: text("status", { enum: ["aktiv", "abgesagt", "pruefen"] })
      .notNull()
      .default("aktiv"),
    // Fail-closed: Neues bleibt intern, bis SL oder Admin zuordnen
    sichtbarkeit: text("sichtbarkeit", {
      enum: ["intern", "leitende", "eltern"],
    })
      .notNull()
      .default("intern"),
  },
  (t) => [
    unique("programm_abteilung_google_event_eindeutig").on(
      t.abteilungId,
      t.googleEventId,
    ),
    check(
      "programm_status_check",
      sql`${t.status} in ('aktiv', 'abgesagt', 'pruefen')`,
    ),
    check(
      "programm_sichtbarkeit_check",
      sql`${t.sichtbarkeit} in ('intern', 'leitende', 'eltern')`,
    ),
    // Ganztägig genau dann, wenn Tage gesetzt und Zeitpunkte leer sind
    check(
      "programm_zeiten_passen_zu_ganztaegig",
      sql`(${t.ganztaegig} and ${t.tagVon} is not null and ${t.tagBis} is not null and ${t.beginn} is null and ${t.ende} is null) or (not ${t.ganztaegig} and ${t.beginn} is not null and ${t.ende} is not null and ${t.tagVon} is null and ${t.tagBis} is null)`,
    ),
  ],
);

export const programmStufe = pgTable(
  "programm_stufe",
  {
    programmId: uuid("programm_id")
      .notNull()
      .references(() => programm.id, { onDelete: "cascade" }),
    stufeId: uuid("stufe_id")
      .notNull()
      .references(() => stufe.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.programmId, t.stufeId] })],
);

// Ohne Zeile gilt «offen»; ein Kind ohne Antwort ist keine Absage
export const teilnahme = pgTable(
  "teilnahme",
  {
    programmId: uuid("programm_id")
      .notNull()
      .references(() => programm.id, { onDelete: "cascade" }),
    kindId: uuid("kind_id")
      .notNull()
      .references(() => kind.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["ja", "nein"] }).notNull(),
    geaendertVon: uuid("geaendert_von").references(() => user.id, {
      onDelete: "set null",
    }),
    geaendertAm: zeitpunkt("geaendert_am").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.programmId, t.kindId] }),
    // text({ enum }) prüft nur in TypeScript, nicht in der Datenbank
    check("teilnahme_status_check", sql`${t.status} in ('ja', 'nein')`),
  ],
);

// Keine Zeile heisst «offen»; dass die Person Leitung einer Stufe des Programms ist, prüft die Route
export const leitungAnmeldung = pgTable(
  "leitung_anmeldung",
  {
    programmId: uuid("programm_id")
      .notNull()
      .references(() => programm.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["ja", "nein"] }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.programmId, t.userId] }),
    // text({ enum }) prüft nur in TypeScript, nicht in der Datenbank
    check("leitung_anmeldung_status_check", sql`${t.status} in ('ja', 'nein')`),
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

// Erinnerung an Eltern ohne Antwort (#242); stufe_id leer heisst: alle Stufen. Wochentag ISO (1 Montag bis 7 Sonntag), Uhrzeit HH:mm Schweizer Zeit
export const zeitregel = pgTable(
  "zeitregel",
  {
    id: id(),
    abteilungId: uuid("abteilung_id")
      .notNull()
      .references(() => abteilung.id, { onDelete: "restrict" }),
    // RESTRICT wie jede Stufen-Referenz; die Löschroute der Stufe löscht die Regeln vorher
    stufeId: uuid("stufe_id").references(() => stufe.id, {
      onDelete: "restrict",
    }),
    wochentag: integer("wochentag").notNull(),
    uhrzeit: text("uhrzeit").notNull(),
    // Der Push-Titel; {Programm} und {Datum} ersetzt der Server
    text: text("text").notNull(),
    // Der Text unter dem Titel; leer heisst: der Push hat keinen
    beschreibung: text("beschreibung"),
    aktiv: boolean("aktiv").notNull().default(true),
    erstelltAm: zeitpunkt("erstellt_am").notNull().defaultNow(),
  },
  (t) => [
    check("zeitregel_wochentag_check", sql`${t.wochentag} between 1 and 7`),
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

// akteur_id und ziel_id ohne Fremdschlüssel, damit das Log Löschungen übersteht
export const auditLog = pgTable("audit_log", {
  id: id(),
  abteilungId: uuid("abteilung_id")
    .notNull()
    .references(() => abteilung.id, { onDelete: "restrict" }),
  // UUID einer Person oder «cli» für die Kommandozeile, die kein Konto hat
  akteurId: text("akteur_id").notNull(),
  aktion: text("aktion").notNull(),
  zielTyp: text("ziel_typ").notNull(),
  zielId: uuid("ziel_id").notNull(),
  // Ohne Personendaten
  details: jsonb("details"),
  erstelltAm: zeitpunkt("erstellt_am").notNull().defaultNow(),
});

// Das Profilbild einer Person (#173): höchstens eines, vom Server auf 256 × 256 JPEG neu kodiert; die Zeile geht mit dem Konto
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
