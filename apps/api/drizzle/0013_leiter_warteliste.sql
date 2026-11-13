ALTER TABLE "leitung_anmeldung" DROP CONSTRAINT "leitung_anmeldung_status_check";--> statement-breakpoint
ALTER TABLE "leitung_anmeldung" ADD COLUMN "warteliste_seit" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "programm" ADD COLUMN "leitung_hoechstzahl" integer;--> statement-breakpoint
ALTER TABLE "leitung_anmeldung" ADD CONSTRAINT "leitung_anmeldung_warteliste_check" CHECK (("leitung_anmeldung"."status" = 'warteliste') = ("leitung_anmeldung"."warteliste_seit" is not null));--> statement-breakpoint
ALTER TABLE "leitung_anmeldung" ADD CONSTRAINT "leitung_anmeldung_status_check" CHECK ("leitung_anmeldung"."status" in ('ja', 'nein', 'warteliste'));--> statement-breakpoint
ALTER TABLE "programm" ADD CONSTRAINT "programm_leitung_hoechstzahl_check" CHECK ("programm"."leitung_hoechstzahl" is null or ("programm"."leitung_hoechstzahl" >= 1 and "programm"."quelle" = 'manuell'));