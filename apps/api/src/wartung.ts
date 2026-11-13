import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { Db } from "./db/client.js";
import { WARTUNG_ID, wartung } from "./db/schema.js";

export const STANDARD_TEXT =
  "FireResponse wird gerade gewartet. Bitte versuche es später noch einmal.";

// Die Sekunden für Retry-After, wenn kein Ende bekannt oder es schon verstrichen ist; höchstens eine Stunde, damit eine Wartung mit fernem Ende die Apps nicht stundenlang schlafen schickt
const RETRY_STANDARD = 300;
const RETRY_MAXIMUM = 3600;

export async function ladeWartung(db: Pick<Db, "select">) {
  const [zeile] = await db
    .select({
      aktiv: wartung.aktiv,
      text: wartung.text,
      ende: wartung.ende,
      seit: wartung.seit,
    })
    .from(wartung)
    .where(eq(wartung.id, WARTUNG_ID));
  return zeile!;
}

// Alle App-Routen unter /api/v1 und die Anmeldung der App. Ausgenommen: der Status, der Datenschutztext und die Verwaltung, damit das Kantonsadmin-Konto die Wartung beenden kann. Steht vor der Sitzungsprüfung: Auch ohne Sitzung gilt 503, nicht 401
export function wartungssperre(db: Db) {
  return createMiddleware(async (c, next) => {
    const pfad = c.req.path;
    const betroffen =
      pfad.startsWith("/api/v1/") &&
      pfad !== "/api/v1/wartung" &&
      pfad !== "/api/v1/datenschutz" &&
      !pfad.startsWith("/api/v1/admin/")
        ? true
        : // Nur mit X-App-Version: Die Verwaltung im Browser sendet ihn nicht
          c.req.method === "POST" &&
          pfad === "/api/auth/sign-in/username" &&
          c.req.header("X-App-Version") !== undefined;
    if (!betroffen) return next();
    const stand = await ladeWartung(db);
    if (!stand.aktiv) return next();
    const sekunden = stand.ende
      ? Math.ceil((stand.ende.getTime() - Date.now()) / 1000)
      : 0;
    return c.json(
      {
        code: "WARTUNG",
        message: stand.text ?? STANDARD_TEXT,
        ende: stand.ende,
      },
      503,
      {
        "Retry-After": String(
          sekunden > 0 ? Math.min(sekunden, RETRY_MAXIMUM) : RETRY_STANDARD,
        ),
      },
    );
  });
}
