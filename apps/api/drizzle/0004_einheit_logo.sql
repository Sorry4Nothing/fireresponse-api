ALTER TABLE "einheit" ADD COLUMN "logo_bild" "bytea";--> statement-breakpoint
ALTER TABLE "einheit" ADD COLUMN "logo_bild_typ" text;--> statement-breakpoint
ALTER TABLE "einheit" ADD CONSTRAINT "einheit_logo_check" CHECK (("einheit"."logo_bild" is null and "einheit"."logo_bild_typ" is null) or ("einheit"."logo_bild" is not null and "einheit"."logo_bild_typ" in ('svg', 'png') and octet_length("einheit"."logo_bild") <= 512000));--> statement-breakpoint
-- Bestehende Einheiten ohne Ränge bekommen die Standard-Ränge (wie STANDARD_RAENGE in einheiten.ts)
INSERT INTO "rang" ("einheit_id", "name", "kuerzel", "reihenfolge", "abzeichen_sterne")
SELECT e."id", 'Rang ' || n, 'R' || n, (n + 1) * 10, n
FROM "einheit" e CROSS JOIN generate_series(0, 5) AS n
WHERE NOT EXISTS (SELECT 1 FROM "rang" r WHERE r."einheit_id" = e."id");
