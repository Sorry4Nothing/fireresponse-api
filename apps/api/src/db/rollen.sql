-- Rollen der Datenbank, als Superuser in der Ziel-Datenbank auszuführen; mehrfach ausführbar
-- Ohne Passwort: Compose und CI vertrauen lokalen Verbindungen (trust)
DO $$
BEGIN
  -- Besitzer der Datenbank und damit des Schemas public; führt die Migrationen aus
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fireresponse_besitzer') THEN
    CREATE ROLE fireresponse_besitzer LOGIN;
  END IF;
  -- Rolle der API; ihre Rechte an den Tabellen vergibt die Migration 0001
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fireresponse_api') THEN
    CREATE ROLE fireresponse_api LOGIN;
  END IF;
  -- current_database() statt eines festen Namens: Compose, CI und Tests nutzen verschiedene Datenbanken
  EXECUTE format('ALTER DATABASE %I OWNER TO fireresponse_besitzer', current_database());
END
$$;
