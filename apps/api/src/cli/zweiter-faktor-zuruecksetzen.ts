import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { verbindeDatenbank } from "../datenbank.js";
import { erstelleDb } from "../db/client.js";
import { user } from "../db/schema.js";
import { setzeZweitenFaktorZurueck } from "../zweiter-faktor.js";

const VERWENDUNG =
  "Verwendung: npm run zweiter-faktor:zuruecksetzen -w apps/api -- --benutzername <benutzername>";

// Die Meldung eines parseArgs-Fehlers nie ausgeben: Sie wiederholt ein positionales Argument, womöglich ein getipptes Passwort
function leseBenutzername() {
  try {
    const { values } = parseArgs({
      options: { benutzername: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    // Das username-Plugin speichert kleingeschrieben
    return values.benutzername?.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

// Letzter Ausweg, wenn kein Admin mehr durch den zweiten Faktor kommt, auch nach einem Wechsel des Auth-Geheimnisses: Darum ohne better-auth, nur mit der Datenbank
const benutzername = leseBenutzername();
if (!benutzername) {
  console.error(VERWENDUNG);
  process.exitCode = 1;
} else {
  const url = process.env.DATABASE_URL;
  // Nur der Name: Die URL kann ein Passwort enthalten
  if (!url) throw new Error("Fehlende Umgebungsvariable: DATABASE_URL");
  const sql = verbindeDatenbank(url);
  try {
    const db = erstelleDb(sql);
    const [ziel] = await db
      .select({ id: user.id, abteilungId: user.abteilungId })
      .from(user)
      .where(eq(user.username, benutzername));
    if (!ziel) {
      console.error(`Keine Person mit dem Benutzernamen «${benutzername}».`);
      process.exitCode = 1;
    } else if (
      await setzeZweitenFaktorZurueck(db, {
        zielId: ziel.id,
        abteilungId: ziel.abteilungId,
        akteurId: "cli",
      })
    ) {
      console.log(
        `Zweiter Faktor von «${benutzername}» zurückgesetzt. Die Person meldet sich ohne Code an und richtet ihn in der App neu ein.`,
      );
    } else {
      console.error(`«${benutzername}» hat keinen zweiten Faktor.`);
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}
