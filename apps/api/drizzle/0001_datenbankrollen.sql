-- Rechte der API-Rolle: Daten lesen und schreiben, aber nichts am Schema ändern
-- Auch für ein neu angelegtes Schema public, auf dem PUBLIC keine Rechte hat
GRANT USAGE ON SCHEMA public TO fireresponse_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fireresponse_api;
--> statement-breakpoint
-- Spätere Tabellen bekommen dieselben Rechte; Ausnahmen brauchen ein eigenes REVOKE
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fireresponse_api;
--> statement-breakpoint
-- Das Audit-Log nur lesen und ergänzen
REVOKE UPDATE, DELETE ON audit_log FROM fireresponse_api;
