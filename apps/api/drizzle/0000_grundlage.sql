CREATE TABLE "abteilung" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"abteilung_id" uuid NOT NULL,
	"akteur_id" text NOT NULL,
	"aktion" text NOT NULL,
	"ziel_typ" text NOT NULL,
	"ziel_id" uuid NOT NULL,
	"details" jsonb,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kind" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"abteilung_id" uuid NOT NULL,
	"vorname" text NOT NULL,
	"nachname" text NOT NULL,
	"stufe_id" uuid NOT NULL,
	"stufe_seit" timestamp with time zone DEFAULT now() NOT NULL,
	"inaktiv_seit" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "kind_eltern" (
	"kind_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kind_eltern_kind_id_user_id_pk" PRIMARY KEY("kind_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "leitung_anmeldung" (
	"programm_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "leitung_anmeldung_programm_id_user_id_pk" PRIMARY KEY("programm_id","user_id"),
	CONSTRAINT "leitung_anmeldung_status_check" CHECK ("leitung_anmeldung"."status" in ('ja', 'nein'))
);
--> statement-breakpoint
CREATE TABLE "profilbild" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"inhalt" "bytea" NOT NULL,
	"geaendert_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profilbild_inhalt_klein" CHECK (octet_length("profilbild"."inhalt") <= 262144)
);
--> statement-breakpoint
CREATE TABLE "programm" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"abteilung_id" uuid NOT NULL,
	"google_event_id" text NOT NULL,
	"google_serie" text,
	"titel" text NOT NULL,
	"ganztaegig" boolean NOT NULL,
	"beginn" timestamp with time zone,
	"ende" timestamp with time zone,
	"tag_von" date,
	"tag_bis" date,
	"google_ort" text,
	"google_beschreibung" text,
	"status" text DEFAULT 'aktiv' NOT NULL,
	"sichtbarkeit" text DEFAULT 'intern' NOT NULL,
	CONSTRAINT "programm_abteilung_google_event_eindeutig" UNIQUE("abteilung_id","google_event_id"),
	CONSTRAINT "programm_status_check" CHECK ("programm"."status" in ('aktiv', 'abgesagt', 'pruefen')),
	CONSTRAINT "programm_sichtbarkeit_check" CHECK ("programm"."sichtbarkeit" in ('intern', 'leitende', 'eltern')),
	CONSTRAINT "programm_zeiten_passen_zu_ganztaegig" CHECK (("programm"."ganztaegig" and "programm"."tag_von" is not null and "programm"."tag_bis" is not null and "programm"."beginn" is null and "programm"."ende" is null) or (not "programm"."ganztaegig" and "programm"."beginn" is not null and "programm"."ende" is not null and "programm"."tag_von" is null and "programm"."tag_bis" is null))
);
--> statement-breakpoint
CREATE TABLE "programm_stufe" (
	"programm_id" uuid NOT NULL,
	"stufe_id" uuid NOT NULL,
	CONSTRAINT "programm_stufe_programm_id_stufe_id_pk" PRIMARY KEY("programm_id","stufe_id")
);
--> statement-breakpoint
CREATE TABLE "push_token" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"plattform" text NOT NULL,
	"zuletzt_gesehen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_token_token_unique" UNIQUE("token"),
	CONSTRAINT "push_token_plattform_check" CHECK ("push_token"."plattform" in ('ios', 'android'))
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "rolle" (
	"user_id" uuid NOT NULL,
	"stufe_id" uuid NOT NULL,
	"typ" text NOT NULL,
	"prioritaet" integer,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rolle_user_id_stufe_id_pk" PRIMARY KEY("user_id","stufe_id"),
	CONSTRAINT "rolle_prioritaet_check" CHECK ("rolle"."prioritaet" >= 1),
	CONSTRAINT "rolle_typ_check" CHECK ("rolle"."typ" in ('leitung', 'stufenleitung'))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token"),
	CONSTRAINT "session_ohne_ip_und_user_agent" CHECK ("session"."ip_address" is null and "session"."user_agent" is null)
);
--> statement-breakpoint
CREATE TABLE "stufe" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"abteilung_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kuerzel" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teilnahme" (
	"programm_id" uuid NOT NULL,
	"kind_id" uuid NOT NULL,
	"status" text NOT NULL,
	"geaendert_von" uuid,
	"geaendert_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teilnahme_programm_id_kind_id_pk" PRIMARY KEY("programm_id","kind_id"),
	CONSTRAINT "teilnahme_status_check" CHECK ("teilnahme"."status" in ('ja', 'nein'))
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" uuid NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"username" text,
	"display_username" text,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"two_factor_enabled" boolean DEFAULT false,
	"abteilung_id" uuid NOT NULL,
	"muss_passwort_aendern" boolean DEFAULT true NOT NULL,
	"startpasswort_gueltig_bis" timestamp with time zone,
	"startpasswort_verschluesselt" text,
	"fehlversuche" integer DEFAULT 0 NOT NULL,
	"naechster_versuch_ab" timestamp with time zone,
	"deaktiviert_am" timestamp with time zone,
	"telefon" text,
	"push_programme" boolean DEFAULT true NOT NULL,
	"push_anmeldungen" boolean DEFAULT true NOT NULL,
	"datenschutz_gelesen_am" timestamp with time zone,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zeitregel" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"abteilung_id" uuid NOT NULL,
	"stufe_id" uuid,
	"wochentag" integer NOT NULL,
	"uhrzeit" text NOT NULL,
	"text" text NOT NULL,
	"beschreibung" text,
	"aktiv" boolean DEFAULT true NOT NULL,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zeitregel_wochentag_check" CHECK ("zeitregel"."wochentag" between 1 and 7),
	CONSTRAINT "zeitregel_uhrzeit_check" CHECK ("zeitregel"."uhrzeit" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
--> statement-breakpoint
CREATE TABLE "zeitregel_gesendet" (
	"regel_id" uuid NOT NULL,
	"programm_id" uuid NOT NULL,
	"gesendet_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zeitregel_gesendet_regel_id_programm_id_pk" PRIMARY KEY("regel_id","programm_id")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_abteilung_id_abteilung_id_fk" FOREIGN KEY ("abteilung_id") REFERENCES "public"."abteilung"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kind" ADD CONSTRAINT "kind_abteilung_id_abteilung_id_fk" FOREIGN KEY ("abteilung_id") REFERENCES "public"."abteilung"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kind" ADD CONSTRAINT "kind_stufe_id_stufe_id_fk" FOREIGN KEY ("stufe_id") REFERENCES "public"."stufe"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kind_eltern" ADD CONSTRAINT "kind_eltern_kind_id_kind_id_fk" FOREIGN KEY ("kind_id") REFERENCES "public"."kind"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kind_eltern" ADD CONSTRAINT "kind_eltern_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leitung_anmeldung" ADD CONSTRAINT "leitung_anmeldung_programm_id_programm_id_fk" FOREIGN KEY ("programm_id") REFERENCES "public"."programm"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leitung_anmeldung" ADD CONSTRAINT "leitung_anmeldung_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profilbild" ADD CONSTRAINT "profilbild_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programm" ADD CONSTRAINT "programm_abteilung_id_abteilung_id_fk" FOREIGN KEY ("abteilung_id") REFERENCES "public"."abteilung"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programm_stufe" ADD CONSTRAINT "programm_stufe_programm_id_programm_id_fk" FOREIGN KEY ("programm_id") REFERENCES "public"."programm"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programm_stufe" ADD CONSTRAINT "programm_stufe_stufe_id_stufe_id_fk" FOREIGN KEY ("stufe_id") REFERENCES "public"."stufe"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_token" ADD CONSTRAINT "push_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_token" ADD CONSTRAINT "push_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rolle" ADD CONSTRAINT "rolle_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rolle" ADD CONSTRAINT "rolle_stufe_id_stufe_id_fk" FOREIGN KEY ("stufe_id") REFERENCES "public"."stufe"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stufe" ADD CONSTRAINT "stufe_abteilung_id_abteilung_id_fk" FOREIGN KEY ("abteilung_id") REFERENCES "public"."abteilung"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teilnahme" ADD CONSTRAINT "teilnahme_programm_id_programm_id_fk" FOREIGN KEY ("programm_id") REFERENCES "public"."programm"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teilnahme" ADD CONSTRAINT "teilnahme_kind_id_kind_id_fk" FOREIGN KEY ("kind_id") REFERENCES "public"."kind"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teilnahme" ADD CONSTRAINT "teilnahme_geaendert_von_user_id_fk" FOREIGN KEY ("geaendert_von") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_abteilung_id_abteilung_id_fk" FOREIGN KEY ("abteilung_id") REFERENCES "public"."abteilung"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zeitregel" ADD CONSTRAINT "zeitregel_abteilung_id_abteilung_id_fk" FOREIGN KEY ("abteilung_id") REFERENCES "public"."abteilung"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zeitregel" ADD CONSTRAINT "zeitregel_stufe_id_stufe_id_fk" FOREIGN KEY ("stufe_id") REFERENCES "public"."stufe"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zeitregel_gesendet" ADD CONSTRAINT "zeitregel_gesendet_regel_id_zeitregel_id_fk" FOREIGN KEY ("regel_id") REFERENCES "public"."zeitregel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zeitregel_gesendet" ADD CONSTRAINT "zeitregel_gesendet_programm_id_programm_id_fk" FOREIGN KEY ("programm_id") REFERENCES "public"."programm"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stufe_name_pro_abteilung" ON "stufe" USING btree ("abteilung_id",lower("name"));--> statement-breakpoint
CREATE INDEX "two_factor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "two_factor_user_id_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");