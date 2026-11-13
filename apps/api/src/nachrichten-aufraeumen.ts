import { sql as roh } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { nachricht } from "./db/schema.js";
import { fehlerCode, log } from "./log.js";

// Löscht Mitteilungen 6 Monate nach ihrem Ablauf, ohne Ablauf 6 Monate nach dem Erstellen; die Lesemarken gehen per CASCADE mit
export async function loescheAlteNachrichten(db: Db) {
  const geloescht = await db
    .delete(nachricht)
    .where(
      roh`coalesce(${nachricht.laeuftAbAm}, ${nachricht.erstelltAm}) < now() - interval '6 months'`,
    )
    .returning({ id: nachricht.id });
  return geloescht.length;
}

// Startet den Lauf sofort und dann alle 24 Stunden; ins Log kommt nur die Anzahl, bei einem Fehler nur sein Code
export function starteNachrichtenAufraeumen(lauf: () => Promise<number>) {
  const starte = () =>
    lauf()
      .then((anzahl) =>
        log(undefined, { ereignis: "nachrichten", geloescht: anzahl }),
      )
      .catch((fehler) =>
        log(undefined, {
          ereignis: "nachrichten",
          code: fehlerCode(fehler) ?? "unerwartet",
        }),
      );
  void starte();
  return setInterval(starte, 24 * 60 * 60 * 1000);
}
