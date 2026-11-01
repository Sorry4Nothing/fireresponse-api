import { parseArgs } from "node:util";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { erstelleAuth, platzhalterEmail } from "../auth.js";
import { verbindeDatenbank } from "../datenbank.js";
import { erstelleDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import { ladeKonfiguration } from "../konfiguration.js";
import {
  erzeugeStartpasswort,
  normalisiereStartpasswort,
  startpasswortFelder,
} from "../startpasswort.js";

const VERWENDUNG = `Verwendung: npm run admin:anlegen -w apps/api -- --benutzername <benutzername> --name "<Vorname Nachname>" (--abteilung <Name> | --neue-abteilung <Name>)
--abteilung nimmt eine bestehende Abteilung, --neue-abteilung legt eine an; genau eine der beiden Angaben.
Das Startpasswort erzeugt die CLI selbst und nimmt keines entgegen.`;

// Eigene Abbrüche mit gefahrlos druckbarer Meldung; fremde Meldungen könnten Eingaben oder Hosts wiederholen
class AbbruchFehler extends Error {}

// Die Meldung eines parseArgs-Fehlers nie ausgeben: Sie wiederholt ein positionales Argument, womöglich ein getipptes Passwort
function leseArgumente() {
  try {
    const { values } = parseArgs({
      options: {
        benutzername: { type: "string" },
        name: { type: "string" },
        abteilung: { type: "string" },
        "neue-abteilung": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    const benutzername = values.benutzername?.trim();
    const name = values.name?.trim();
    const neu = values["neue-abteilung"] !== undefined;
    if (neu === (values.abteilung !== undefined)) return null;
    const abteilungsname = (
      values.abteilung ?? values["neue-abteilung"]
    )?.trim();
    if (!benutzername || !name || !abteilungsname) return null;
    return { benutzername, name, neu, abteilungsname };
  } catch {
    return null;
  }
}

function beschreibe(fehler: unknown) {
  if (fehler instanceof AbbruchFehler) return fehler.message;
  if (fehler instanceof APIError) {
    return [fehler.body?.code ?? fehler.status, fehler.body?.message]
      .filter(Boolean)
      .join(" ");
  }
  // Nur Code oder Name: postgres-js nennt Host, Port und Werte in der Meldung
  const { code, name } = fehler as { code?: unknown; name?: unknown };
  return String(code ?? name);
}

const argumente = leseArgumente();
if (!argumente) {
  console.error(VERWENDUNG);
  process.exitCode = 1;
} else {
  // Wie server.ts: ohne gültige Konfiguration endet der Prozess hier mit Status 1
  const konfiguration = ladeKonfiguration(process.env);
  const sql = verbindeDatenbank(konfiguration.DATABASE_URL);
  try {
    const db = erstelleDb(sql);
    const { benutzername, name, neu, abteilungsname } = argumente;
    // Eine Transaktion für alle Schreibzugriffe: createUser legt den User vor der HIBP-Prüfung an, ein Fehlschlag dort liesse sonst ein Konto ohne Passwort zurück
    const ergebnis = await db.transaction(async (tx) => {
      let abteilungId: string;
      if (neu) {
        const vorhandene = await tx
          .select({ id: schema.abteilung.id })
          .from(schema.abteilung)
          .where(eq(schema.abteilung.name, abteilungsname));
        if (vorhandene.length > 0) {
          throw new AbbruchFehler(
            `Abteilung «${abteilungsname}» gibt es schon.`,
          );
        }
        const [angelegt] = await tx
          .insert(schema.abteilung)
          .values({ name: abteilungsname })
          .returning({ id: schema.abteilung.id });
        abteilungId = angelegt.id;
      } else {
        const zeilen = await tx
          .select({ id: schema.abteilung.id })
          .from(schema.abteilung)
          .where(eq(schema.abteilung.name, abteilungsname));
        if (zeilen.length !== 1) {
          throw new AbbruchFehler(
            `Keine eindeutige Abteilung «${abteilungsname}».`,
          );
        }
        abteilungId = zeilen[0].id;
      }
      const auth = erstelleAuth(
        drizzleAdapter(tx, { provider: "pg", schema, transaction: true }),
      );
      const startpasswort = erzeugeStartpasswort();
      // Ohne Header prüft createUser keine Rechte; genau das braucht die CLI, die kein Konto hat
      const { user } = await auth.api.createUser({
        body: {
          email: platzhalterEmail(),
          password: normalisiereStartpasswort(startpasswort),
          name,
          role: "admin",
          data: {
            username: benutzername,
            abteilungId,
            ...startpasswortFelder(new Date(), startpasswort),
          },
        },
      });
      await tx.insert(schema.auditLog).values({
        abteilungId,
        akteurId: "cli",
        aktion: "person_angelegt",
        zielTyp: "person",
        zielId: user.id,
      });
      // Zur Laufzeit vorhanden; der Typ UserWithRole kennt das Feld des username-Plugins nicht
      return {
        gespeichert: (user as { username?: string }).username,
        startpasswort,
      };
    });
    // stdout erst nach dem Commit: Ein zurückgenommenes Startpasswort darf nie gedruckt sein
    if (neu) console.log(`Abteilung «${abteilungsname}» angelegt.`);
    console.log(`Admin «${ergebnis.gespeichert}» angelegt.`);
    console.log(`Startpasswort: ${ergebnis.startpasswort}`);
    console.log(
      "Nicht weiterleiten. Gilt 7 Tage und nur für die erste Anmeldung.",
    );
  } catch (fehler) {
    console.error(`Admin nicht angelegt: ${beschreibe(fehler)}`);
    process.exitCode = 1;
  } finally {
    // Kein process.exit(): offene Verbindungen zeigten sich in Tests nur als Timeout
    await sql.end();
  }
}
