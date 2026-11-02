import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// Nur der Besitzer der Tabellen migriert; die API-Rolle darf das Schema nicht ändern
const url = process.env.MIGRATION_DATABASE_URL;
// Nur der Name: Die URL kann ein Passwort enthalten
if (!url) throw new Error("Fehlende Umgebungsvariable: MIGRATION_DATABASE_URL");

// Eine Verbindung für die DDL; die NOTICEs des Migrators («already exists») sind kein Fehler
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await migrate(drizzle(sql), {
    // Unabhängig vom Arbeitsverzeichnis
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
} finally {
  await sql.end();
}
