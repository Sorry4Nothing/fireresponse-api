import { verbindeDatenbank } from "../datenbank.js";
import { erstelleDb } from "../db/client.js";
import { session } from "../db/schema.js";

// Für den Ablauf bei einer Datenpanne: Jede Sitzung endet sofort; Konten, Passwörter und zweite Faktoren bleiben
const url = process.env.DATABASE_URL;
// Nur der Name: Die URL kann ein Passwort enthalten
if (!url) throw new Error("Fehlende Umgebungsvariable: DATABASE_URL");

const sql = verbindeDatenbank(url);
try {
  const beendet = await erstelleDb(sql)
    .delete(session)
    .returning({ id: session.id });
  console.log(`Beendete Sitzungen: ${beendet.length}`);
} finally {
  await sql.end();
}
