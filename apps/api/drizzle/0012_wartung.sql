CREATE TABLE "wartung" (
	"id" uuid PRIMARY KEY NOT NULL,
	"aktiv" boolean DEFAULT false NOT NULL,
	"text" text,
	"ende" timestamp with time zone,
	"seit" timestamp with time zone,
	CONSTRAINT "wartung_einzeln" CHECK ("wartung"."id" = '00000000-0000-4000-8000-000000000001'),
	CONSTRAINT "wartung_text_kurz" CHECK (char_length("wartung"."text") <= 280),
	CONSTRAINT "wartung_aus_leer" CHECK ("wartung"."aktiv" or ("wartung"."text" is null and "wartung"."ende" is null and "wartung"."seit" is null)),
	CONSTRAINT "wartung_an_seit" CHECK (not "wartung"."aktiv" or "wartung"."seit" is not null)
);
--> statement-breakpoint
-- Die eine Zeile gibt es von Anfang an: Der Code liest und ändert sie nur
INSERT INTO "wartung" ("id") VALUES ('00000000-0000-4000-8000-000000000001');
