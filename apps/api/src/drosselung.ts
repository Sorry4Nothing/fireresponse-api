import type { MiddlewareHandler } from "hono";
import { ZU_VIELE_ANFRAGEN } from "./auth.js";

// Anfragen je Minute und Absender-Adresse. Allgemein gross genug für einen Elternabend im selben WLAN
export const LIMIT_ALLGEMEIN = 600;
export const LIMIT_OEFFENTLICH = 30;
// Mitteilungen an die Verwaltung je Minute und Adresse: ein Kantonsadmin sendet wenige
export const LIMIT_NACHRICHTEN = 5;

const FENSTER_MS = 60_000;

// shortcut: Zähler im Speicher der einen Instanz, nach einem Neustart leer; bei mehreren Instanzen in die Tabelle rate_limit verlagern
export function erstelleDrosselung(
  max: number,
  jetzt: () => number = Date.now,
): MiddlewareHandler {
  const zaehler = new Map<string, { start: number; n: number }>();
  return async (c, next) => {
    // Wie das Limit der Anmeldung: Nur der Header, den der Edge-Caddy setzt. Ohne ihn (Healthcheck im Netz, Tests) zählt nichts
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (!ip) return next();
    const t = jetzt();
    // Abgelaufene Fenster fallen heraus, sonst wüchse die Liste mit jeder neuen Adresse
    if (zaehler.size > 10_000) {
      for (const [schluessel, z] of zaehler) {
        if (t - z.start >= FENSTER_MS) zaehler.delete(schluessel);
      }
    }
    let z = zaehler.get(ip);
    if (!z || t - z.start >= FENSTER_MS) {
      z = { start: t, n: 0 };
      zaehler.set(ip, z);
    }
    if (++z.n > max) {
      return c.json(ZU_VIELE_ANFRAGEN, 429, {
        "X-Retry-After": String(Math.ceil((z.start + FENSTER_MS - t) / 1000)),
      });
    }
    return next();
  };
}
