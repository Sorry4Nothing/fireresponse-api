ALTER TABLE "zeitregel" DROP CONSTRAINT "zeitregel_wochentag_check";--> statement-breakpoint
ALTER TABLE "zeitregel" ADD COLUMN "tage_vorher" integer NOT NULL DEFAULT 1;--> statement-breakpoint
-- Ein Wochentag lässt sich nicht in einen festen Abstand umrechnen: Bestehende Regeln bleiben, sind aber aus, bis die Verwaltung den Abstand setzt
UPDATE "zeitregel" SET "aktiv" = false;--> statement-breakpoint
ALTER TABLE "zeitregel" ALTER COLUMN "tage_vorher" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "zeitregel" DROP COLUMN "wochentag";--> statement-breakpoint
ALTER TABLE "zeitregel" ADD CONSTRAINT "zeitregel_tage_vorher_check" CHECK ("zeitregel"."tage_vorher" between 0 and 7);
