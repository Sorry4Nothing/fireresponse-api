import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { BESITZER_URL, SUPERUSER_URL } from "./hilfen/datenbank.js";

// Vitest ruft den default-Export einmal pro Lauf auf; die zurückgegebene Funktion ist der Teardown
export default async function frischeDatenbank() {
  // max_lifetime: null hält die Verbindung: postgres-js beendet sie sonst nach 30 bis 60 Minuten, und eine offene Watch-Session verlöre die Sperre
  const sql = postgres(SUPERUSER_URL, {
    max: 1,
    max_lifetime: null,
    onnotice: () => {},
  });
  try {
    // Sperre in der Datenbank postgres: Ein zweiter gleichzeitiger Lauf wartet, statt dem ersten die Datenbank wegzulöschen
    await sql`select pg_advisory_lock(hashtext('fireresponse_test'))`;
    await sql`drop database if exists fireresponse_test with (force)`;
    await sql`create database fireresponse_test owner fireresponse_besitzer`;
    // Migration über den echten Einstieg, wie auf dem Server
    execFileSync(process.execPath, ["--import", "tsx", "src/db/migrieren.ts"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, MIGRATION_DATABASE_URL: BESITZER_URL },
      stdio: "inherit",
    });
  } catch (fehler) {
    // Für ein gescheitertes Setup registriert Vitest keinen Teardown; eine offene Verbindung hielte den Lauf bis zum teardownTimeout
    await sql.end();
    throw fehler;
  }
  // Die Datenbank bleibt zur Inspektion stehen; mit der Verbindung fällt die Sperre
  return () => sql.end();
}
