import { afterAll, expect, test, vi } from "vitest";
import { verbindeDatenbank } from "../src/datenbank.js";
import { API_URL } from "./hilfen/datenbank.js";

// Prüft mit dem Client des Servers, dass die Datenbank aus docker-compose.yml bzw. der Service der CI erreichbar ist
const sql = verbindeDatenbank(API_URL);

afterAll(() => sql.end());

test("PostgreSQL 18 ist erreichbar", async () => {
  const [zeile] =
    await sql`select current_setting('server_version_num')::int as version`;
  expect(zeile.version).toBeGreaterThanOrEqual(180000);
});

test("NOTICEs der Datenbank kommen nicht auf die Konsole", async () => {
  const ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
  await sql`do $$ begin raise notice 'Max Muster'; end $$`;
  expect(ausgabe).not.toHaveBeenCalled();
  ausgabe.mockRestore();
});
