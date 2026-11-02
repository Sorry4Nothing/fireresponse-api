-- Standard-Ränge sind vier: Rang 0 ohne Abzeichen, Rang 1 ohne Stern, Rang 2 mit 1 Stern, Rang 3 mit 2 Sternen (wie STANDARD_RAENGE in einheiten.ts).
-- Nur unveränderte Standard-Ränge der Migration 0004 werden umgestellt: Name, Kürzel und Sterne wie ausgeliefert, kein eigenes Bild.
-- Rang 4 und 5 fallen weg, sofern niemand sie hat; wer sie nutzt, behält sie.
DELETE FROM "rang" r
WHERE r."name" IN ('Rang 4', 'Rang 5')
  AND r."kuerzel" = 'R' || right(r."name", 1)
  AND r."abzeichen_sterne" = right(r."name", 1)::int
  AND r."abzeichen_bild" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "einheit_rolle" x WHERE x."rang_id" = r."id")
  AND NOT EXISTS (SELECT 1 FROM "teilnehmende" t WHERE t."rang_id" = r."id");--> statement-breakpoint
UPDATE "rang" r
SET "abzeichen_sterne" = CASE r."name" WHEN 'Rang 0' THEN NULL ELSE right(r."name", 1)::int - 1 END
WHERE r."name" IN ('Rang 0', 'Rang 1', 'Rang 2', 'Rang 3')
  AND r."kuerzel" = 'R' || right(r."name", 1)
  AND r."abzeichen_sterne" = right(r."name", 1)::int
  AND r."abzeichen_bild" IS NULL;
