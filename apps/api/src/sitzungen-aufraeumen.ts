import { lt, sql as roh } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { session } from "./db/schema.js";
import { fehlerCode, log } from "./log.js";

// better-auth löscht eine abgelaufene Sitzung nur, wenn ihr Cookie noch einmal kommt; CASCADE nimmt das Push-Token mit, sonst bekäme das Gerät weiter Pushes
export async function loescheAbgelaufeneSitzungen(db: Db) {
  const geloescht = await db
    .delete(session)
    .where(lt(session.expiresAt, roh`now()`))
    .returning({ id: session.id });
  return geloescht.length;
}

// Startet den Lauf sofort und dann alle 24 Stunden; ins Log kommt nur die Anzahl, bei einem Fehler nur sein Code
export function starteSitzungenAufraeumen(lauf: () => Promise<number>) {
  const starte = () =>
    lauf()
      .then((anzahl) =>
        log(undefined, { ereignis: "sitzungen", geloescht: anzahl }),
      )
      .catch((fehler) =>
        log(undefined, {
          ereignis: "sitzungen",
          code: fehlerCode(fehler) ?? "unerwartet",
        }),
      );
  void starte();
  return setInterval(starte, 24 * 60 * 60 * 1000);
}
