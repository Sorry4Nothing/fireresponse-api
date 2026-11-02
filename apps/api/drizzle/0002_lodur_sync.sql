ALTER TABLE "einheit" ADD COLUMN "lodur_url_gesetzt_am" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "programm" ADD COLUMN "thema" text;--> statement-breakpoint
ALTER TABLE "programm" ADD COLUMN "info" text;--> statement-breakpoint
ALTER TABLE "programm" ADD COLUMN "aufgebot" text;--> statement-breakpoint
ALTER TABLE "programm" ADD COLUMN "inhalt_hash" text;