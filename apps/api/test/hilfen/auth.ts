import { createHash } from "node:crypto";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { memoryAdapter } from "better-auth/adapters/memory";
import type { TokenMessage } from "firebase-admin/messaging";
import { afterEach, expect, vi } from "vitest";
import { erstelleAuth } from "../../src/auth.js";
import type { Db } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";

// Erfundenes App-Schema; das echte legt die App fest
export const APP = "testapp://";
export const PASSWORT = "nur-fuer-tests-1";
export const GELEAKT = "nur-fuer-tests-geleakt";

// Im Modul-Scope aufrufen, vor dem Bau der Auth-Instanz: better-auth liest beide Umgebungsvariablen beim Erstellen, Vitest friert die Zeitgrenze beim Definieren eines Tests ein, und vi.setConfig gilt nur für die eigene Datei
// Gibt die FCM-Attrappe zurück: Die Push-Tests übergeben sie als `fcm`, lesen `nachrichten` und schalten `ausfall` ein, alle anderen Dateien ignorieren sie
export function bereiteAuthTestsVor() {
  // Jedes Passwort, das better-auth prüft oder speichert, rechnet scrypt mit 32 MiB; auf einem ausgelasteten Rechner wurden bis 19 s pro Test gemessen, ein Vielfaches der 5 s von Vitest. hookTimeout gleich: beforeAll der Rechte-Tests legt 14 Personas an
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
  vi.stubEnv("BETTER_AUTH_URL", "https://fireresponse.invalid");
  vi.stubEnv("BETTER_AUTH_TRUSTED_ORIGINS", APP);

  // Kein Netz im Test: HIBP antwortet aus dieser Attrappe, jeder andere Zugriff lässt den Test scheitern
  const fremdeZugriffe: string[] = [];
  const sha1 = (text: string) =>
    createHash("sha1").update(text).digest("hex").toUpperCase();
  const fcm = {
    nachrichten: [] as TokenMessage[],
    ausfall: false,
    // Die Tokens, die FCM als nicht registriert meldet
    abgemeldet: new Set<string>(),
    zuruecksetzen() {
      this.nachrichten.length = 0;
      this.ausfall = false;
      this.abgemeldet.clear();
    },
    async sendEach(nachrichten: TokenMessage[]) {
      this.nachrichten.push(...nachrichten);
      if (this.ausfall)
        throw Object.assign(new Error("Fehler"), {
          code: "messaging/internal-error",
        });
      return {
        responses: nachrichten.map(({ token }) =>
          this.abgemeldet.has(token)
            ? {
                success: false,
                error: { code: "messaging/registration-token-not-registered" },
              }
            : { success: true },
        ),
      };
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const praefix =
        /^https:\/\/api\.pwnedpasswords\.com\/range\/([0-9A-F]{5})$/.exec(
          String(url),
        )?.[1];
      if (!praefix) {
        fremdeZugriffe.push(String(url));
        throw new Error(`Kein Netz im Test: ${url}`);
      }
      const geleakt = sha1(GELEAKT);
      const zeilen = geleakt.startsWith(praefix) ? `${geleakt.slice(5)}:3` : "";
      return new Response(zeilen, {
        headers: { "content-type": "text/plain" },
      });
    }),
  );
  afterEach(() => expect(fremdeZugriffe.splice(0)).toEqual([]));
  return fcm;
}

// Eigene IP pro Persona oder Anfrage, damit die Testdateien eines Laufs sich kein Rate-Limit-Budget teilen (ohne Header zählen alle als 127.0.0.1). RFC-3849-Dokumentationsnetz, schon in better-auths normalisierter /64-Form: Der Schlüssel in rate_limit ist `${ip}|${pfad}`
export function zufallsIp() {
  const block = () =>
    Math.floor(Math.random() * 0x1_0000)
      .toString(16)
      .padStart(4, "0");
  return `2001:0db8:${block()}:${block()}:0000:0000:0000:0000`;
}

// Wie der Cookie-Speicher des Expo-Clients: Was mit Max-Age=0 kommt, fällt weg; nimmt eine Response oder ein returnHeaders-Ergebnis
export function cookiesAus({ headers }: { headers: Headers }) {
  return headers
    .getSetCookie()
    .filter((c) => !/max-age=0(;|$)/i.test(c))
    .map((c) => c.split(";")[0])
    .join("; ");
}

// Auth wie auf dem Server, aber mit dem Drizzle-Client der Tests
export function erstelleTestAuth(db: Db) {
  return erstelleAuth(
    drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
  );
}

// GET und POST jedes Pfads, den better-auth mit diesen Plugins kennt, ohne die offenen Einträge; so treffen die Tests auch Pfade, die ein Update dazubringt
export function geschlossenePfade(offen: readonly string[]) {
  const pfade = new Set(
    Object.values(erstelleAuth(memoryAdapter({})).api).flatMap((e) =>
      e.path ? [e.path] : [],
    ),
  );
  return [...pfade]
    .flatMap((pfad) => [`GET /api/auth${pfad}`, `POST /api/auth${pfad}`])
    .filter((eintrag) => !offen.includes(eintrag));
}

// So sieht der Push aus, den sendePush an FCM gibt
export const fcmNachricht = (
  token: string,
  title: string,
  data: { typ: string; id: string },
  channelId: string,
  body?: string,
): TokenMessage => ({
  token,
  notification: { title, ...(body && { body }) },
  data,
  android: {
    priority: "high",
    notification: { sound: "default", channelId },
  },
  apns: { payload: { aps: { sound: "default" } } },
});
