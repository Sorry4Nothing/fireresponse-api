ALTER TABLE "rang" ADD COLUMN "typ" text DEFAULT 'jf' NOT NULL;--> statement-breakpoint
-- Bestehende Ränge übernehmen den Typ ihrer Einheit (Kinder- oder Jugendfeuerwehr)
UPDATE "rang" r SET "typ" = e."typ" FROM "einheit" e WHERE e."id" = r."einheit_id";--> statement-breakpoint
ALTER TABLE "rang" ADD CONSTRAINT "rang_typ_check" CHECK ("rang"."typ" in ('kf', 'jf', 'miliz'));
