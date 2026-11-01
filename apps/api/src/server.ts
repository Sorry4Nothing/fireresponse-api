import { serve } from "@hono/node-server";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { erstelleApp } from "./app.js";
import { erstelleAuth } from "./auth.js";
import { kodiereProfilbild } from "./bild-sharp.js";
import { verbindeDatenbank } from "./datenbank.js";
import { erstelleDb } from "./db/client.js";
import * as schema from "./db/schema.js";
import { erstelleFcm } from "./fcm.js";
import { ladeKonfiguration } from "./konfiguration.js";
import { log } from "./log.js";
import { ladeSeiten } from "./seiten.js";
import {
  loescheAbgelaufeneSitzungen,
  starteSitzungenAufraeumen,
} from "./sitzungen-aufraeumen.js";
import {
  pruefeZeitregeln,
  starteZeitregelPruefer,
} from "./zeitregeln/pruefer.js";

// Ohne gültige Konfiguration endet der Prozess hier mit Status 1
const konfiguration = ladeKonfiguration(process.env);
// Einmal beim Start; eine fehlende Seite beendet den Prozess wie eine fehlende Variable
const seiten = ladeSeiten({
  stelle: konfiguration.VERANTWORTLICHE_STELLE,
  email: konfiguration.KONTAKT_EMAIL,
});
// Ohne Schlüsseldatei startet die API und sendet keine Pushes
const fcm = konfiguration.FCM_SCHLUESSEL_DATEI
  ? erstelleFcm(konfiguration.FCM_SCHLUESSEL_DATEI)
  : undefined;
if (!fcm) log(undefined, { ereignis: "push", code: "ohne-schluessel" });
const sql = verbindeDatenbank(konfiguration.DATABASE_URL);
const db = erstelleDb(sql);
const auth = erstelleAuth(
  drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
);
const app = erstelleApp({
  appMinVersion: konfiguration.APP_MIN_VERSION,
  sql,
  db,
  auth,
  fcm,
  kodiereBild: kodiereProfilbild,
  seiten,
});
// Ohne hostname auf allen Schnittstellen: Der Dev-Build auf dem Handy erreicht die API im LAN; in Produktion öffnet nur Caddy Ports
serve({ fetch: app.fetch, port: konfiguration.PORT });
starteSitzungenAufraeumen(() => loescheAbgelaufeneSitzungen(db));
// Ohne Schlüssel gäbe es nichts zu senden, und eine Erinnerung gälte trotzdem als gesendet
if (fcm) {
  starteZeitregelPruefer(() =>
    pruefeZeitregeln({ datenbankUrl: konfiguration.DATABASE_URL, fcm }),
  );
}
