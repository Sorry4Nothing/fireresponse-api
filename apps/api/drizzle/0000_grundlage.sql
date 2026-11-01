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
	"einheit_id" uuid,
	"akteur_id" text NOT NULL,
	"aktion" text NOT NULL,
	"ziel_typ" text NOT NULL,
	"ziel_id" uuid NOT NULL,
	"details" jsonb,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bezirk" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "einheit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"bezirk_id" uuid NOT NULL,
	"typ" text NOT NULL,
	"name" text NOT NULL,
	"lodur_url_verschluesselt" text,
	"sync_ok_am" timestamp with time zone,
	"sync_fehler" text,
	CONSTRAINT "einheit_bezirk_typ_eindeutig" UNIQUE("bezirk_id","typ"),
	CONSTRAINT "einheit_typ_check" CHECK ("einheit"."typ" in ('jf', 'kf'))
);
--> statement-breakpoint
CREATE TABLE "einheit_rolle" (
	"user_id" uuid NOT NULL,
	"einheit_id" uuid NOT NULL,
	"typ" text NOT NULL,
	"reihenfolge" integer,
	"rang_id" uuid,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "einheit_rolle_user_id_einheit_id_pk" PRIMARY KEY("user_id","einheit_id"),
	CONSTRAINT "einheit_rolle_reihenfolge_eindeutig" UNIQUE("einheit_id","reihenfolge"),
	CONSTRAINT "einheit_rolle_typ_check" CHECK ("einheit_rolle"."typ" in ('kommandant', 'stellvertretung', 'leitung')),
	CONSTRAINT "einheit_rolle_reihenfolge_check" CHECK (("einheit_rolle"."typ" = 'stellvertretung' and "einheit_rolle"."reihenfolge" is not null and "einheit_rolle"."reihenfolge" >= 1) or ("einheit_rolle"."typ" <> 'stellvertretung' and "einheit_rolle"."reihenfolge" is null))
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
	"einheit_id" uuid NOT NULL,
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
	CONSTRAINT "programm_einheit_google_event_eindeutig" UNIQUE("einheit_id","google_event_id"),
	CONSTRAINT "programm_status_check" CHECK ("programm"."status" in ('aktiv', 'abgesagt', 'pruefen')),
	CONSTRAINT "programm_zeiten_passen_zu_ganztaegig" CHECK (("programm"."ganztaegig" and "programm"."tag_von" is not null and "programm"."tag_bis" is not null and "programm"."beginn" is null and "programm"."ende" is null) or (not "programm"."ganztaegig" and "programm"."beginn" is not null and "programm"."ende" is not null and "programm"."tag_von" is null and "programm"."tag_bis" is null))
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
CREATE TABLE "rang" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"einheit_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kuerzel" text NOT NULL,
	"reihenfolge" integer NOT NULL,
	"abzeichen_sterne" integer,
	"abzeichen_bild" "bytea",
	"abzeichen_bild_typ" text,
	CONSTRAINT "rang_reihenfolge_pro_einheit" UNIQUE("einheit_id","reihenfolge"),
	CONSTRAINT "rang_id_einheit" UNIQUE("id","einheit_id"),
	CONSTRAINT "rang_reihenfolge_check" CHECK ("rang"."reihenfolge" between 1 and 999),
	CONSTRAINT "rang_sterne_check" CHECK ("rang"."abzeichen_sterne" is null or "rang"."abzeichen_sterne" between 0 and 5),
	CONSTRAINT "rang_abzeichen_eines" CHECK (not ("rang"."abzeichen_sterne" is not null and "rang"."abzeichen_bild" is not null)),
	CONSTRAINT "rang_bild_typ_check" CHECK (("rang"."abzeichen_bild" is null and "rang"."abzeichen_bild_typ" is null) or ("rang"."abzeichen_bild" is not null and "rang"."abzeichen_bild_typ" in ('svg', 'png') and octet_length("rang"."abzeichen_bild") <= 512000))
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
CREATE TABLE "teilnahme" (
	"programm_id" uuid NOT NULL,
	"teilnehmende_id" uuid NOT NULL,
	"status" text NOT NULL,
	"geaendert_von" uuid,
	"geaendert_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teilnahme_programm_id_teilnehmende_id_pk" PRIMARY KEY("programm_id","teilnehmende_id"),
	CONSTRAINT "teilnahme_status_check" CHECK ("teilnahme"."status" in ('ja', 'nein'))
);
--> statement-breakpoint
CREATE TABLE "teilnehmende" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"einheit_id" uuid NOT NULL,
	"vorname" text NOT NULL,
	"nachname" text NOT NULL,
	"rang_id" uuid,
	"inaktiv_seit" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "teilnehmende_konto" (
	"user_id" uuid NOT NULL,
	"teilnehmende_id" uuid NOT NULL,
	"art" text NOT NULL,
	"erstellt_am" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teilnehmende_konto_user_id_teilnehmende_id_pk" PRIMARY KEY("user_id","teilnehmende_id"),
	CONSTRAINT "teilnehmende_konto_art_check" CHECK ("teilnehmende_konto"."art" in ('eltern', 'selbst'))
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
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"two_factor_enabled" boolean DEFAULT false,
	"muss_passwort_aendern" boolean DEFAULT true NOT NULL,
	"startpasswort_gueltig_bis" timestamp with time zone,
	"startpasswort_verschluesselt" text,
	"fehlversuche" integer DEFAULT 0 NOT NULL,
	"naechster_versuch_ab" timestamp with time zone,
	"deaktiviert_am" timestamp with time zone,
	"telefon" text,
	"push_programme" boolean DEFAULT true NOT NULL,
	"push_anmeldungen" boolean DEFAULT true NOT NULL,
	"einwilligung_am" timestamp with time zone,
	"einwilligung_version" integer,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_username_unique" UNIQUE("username"),
	CONSTRAINT "user_username_regel" CHECK ("user"."username" is null or ("user"."username" ~ '^[A-Za-z0-9._-]{3,64}$' and "user"."username" = lower("user"."username"))),
	CONSTRAINT "user_einwilligung_zusammen" CHECK (("user"."einwilligung_am" is null) = ("user"."einwilligung_version" is null))
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
	"einheit_id" uuid NOT NULL,
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
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_einheit_id_einheit_id_fk" FOREIGN KEY ("einheit_id") REFERENCES "public"."einheit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einheit" ADD CONSTRAINT "einheit_bezirk_id_bezirk_id_fk" FOREIGN KEY ("bezirk_id") REFERENCES "public"."bezirk"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einheit_rolle" ADD CONSTRAINT "einheit_rolle_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einheit_rolle" ADD CONSTRAINT "einheit_rolle_einheit_id_einheit_id_fk" FOREIGN KEY ("einheit_id") REFERENCES "public"."einheit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einheit_rolle" ADD CONSTRAINT "einheit_rolle_rang_der_einheit" FOREIGN KEY ("rang_id","einheit_id") REFERENCES "public"."rang"("id","einheit_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leitung_anmeldung" ADD CONSTRAINT "leitung_anmeldung_programm_id_programm_id_fk" FOREIGN KEY ("programm_id") REFERENCES "public"."programm"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leitung_anmeldung" ADD CONSTRAINT "leitung_anmeldung_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profilbild" ADD CONSTRAINT "profilbild_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programm" ADD CONSTRAINT "programm_einheit_id_einheit_id_fk" FOREIGN KEY ("einheit_id") REFERENCES "public"."einheit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_token" ADD CONSTRAINT "push_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_token" ADD CONSTRAINT "push_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rang" ADD CONSTRAINT "rang_einheit_id_einheit_id_fk" FOREIGN KEY ("einheit_id") REFERENCES "public"."einheit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teilnahme" ADD CONSTRAINT "teilnahme_programm_id_programm_id_fk" FOREIGN KEY ("programm_id") REFERENCES "public"."programm"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teilnahme" ADD CONSTRAINT "teilnahme_teilnehmende_id_teilnehmende_id_fk" FOREIGN KEY ("teilnehmende_id") REFERENCES "public"."teilnehmende"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teilnahme" ADD CONSTRAINT "teilnahme_geaendert_von_user_id_fk" FOREIGN KEY ("geaendert_von") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teilnehmende" ADD CONSTRAINT "teilnehmende_einheit_id_einheit_id_fk" FOREIGN KEY ("einheit_id") REFERENCES "public"."einheit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teilnehmende" ADD CONSTRAINT "teilnehmende_rang_der_einheit" FOREIGN KEY ("rang_id","einheit_id") REFERENCES "public"."rang"("id","einheit_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teilnehmende_konto" ADD CONSTRAINT "teilnehmende_konto_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teilnehmende_konto" ADD CONSTRAINT "teilnehmende_konto_teilnehmende_id_teilnehmende_id_fk" FOREIGN KEY ("teilnehmende_id") REFERENCES "public"."teilnehmende"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zeitregel" ADD CONSTRAINT "zeitregel_einheit_id_einheit_id_fk" FOREIGN KEY ("einheit_id") REFERENCES "public"."einheit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zeitregel_gesendet" ADD CONSTRAINT "zeitregel_gesendet_regel_id_zeitregel_id_fk" FOREIGN KEY ("regel_id") REFERENCES "public"."zeitregel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zeitregel_gesendet" ADD CONSTRAINT "zeitregel_gesendet_programm_id_programm_id_fk" FOREIGN KEY ("programm_id") REFERENCES "public"."programm"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bezirk_name_eindeutig" ON "bezirk" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "einheit_rolle_ein_kommandant" ON "einheit_rolle" USING btree ("einheit_id") WHERE "einheit_rolle"."typ" = 'kommandant';--> statement-breakpoint
CREATE INDEX "einheit_rolle_einheit_idx" ON "einheit_rolle" USING btree ("einheit_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "teilnehmende_einheit_idx" ON "teilnehmende" USING btree ("einheit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teilnehmende_konto_ein_selbst" ON "teilnehmende_konto" USING btree ("teilnehmende_id") WHERE "teilnehmende_konto"."art" = 'selbst';--> statement-breakpoint
CREATE INDEX "teilnehmende_konto_teilnehmende_idx" ON "teilnehmende_konto" USING btree ("teilnehmende_id");--> statement-breakpoint
CREATE INDEX "two_factor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "two_factor_user_id_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");