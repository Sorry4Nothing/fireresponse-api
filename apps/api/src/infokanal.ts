import { and, eq, isNull, lt, ne, sql as roh } from "drizzle-orm";
import type { Context } from "hono";
import type { Db } from "./db/client.js";
import {
  einheit,
  einheitRolle,
  infokanalMitteilung,
  teilnehmende,
  teilnehmendeKonto,
  user,
} from "./db/schema.js";
import { fehlerCode, log } from "./log.js";
import { type Fcm, sendePush } from "./push.js";
import { aktivesKonto } from "./rechte.js";

// Konten der Einheit ausser der schreibenden Person: Rolle in der Einheit oder aktive Teilnehmende, für die das Konto antwortet; aktives Konto, Schalter pushInfokanal an
async function empfaenger(db: Db, einheitId: string, autorId: string) {
  const schalter = and(
    aktivesKonto(),
    eq(user.pushInfokanal, true),
    ne(user.id, autorId),
  );
  const mitRolle = await db
    .selectDistinct({ id: user.id })
    .from(einheitRolle)
    .innerJoin(user, and(eq(user.id, einheitRolle.userId), schalter))
    .where(eq(einheitRolle.einheitId, einheitId));
  const eltern = await db
    .selectDistinct({ id: user.id })
    .from(teilnehmende)
    .innerJoin(
      teilnehmendeKonto,
      eq(teilnehmendeKonto.teilnehmendeId, teilnehmende.id),
    )
    .innerJoin(user, and(eq(user.id, teilnehmendeKonto.userId), schalter))
    .where(
      and(
        eq(teilnehmende.einheitId, einheitId),
        isNull(teilnehmende.inaktivSeit),
      ),
    );
  // Wer mehrere Rollen oder Kinder hat, kommt einmal vor
  return [...new Set([...mitRolle, ...eltern].map(({ id }) => id))];
}

// Nach dem Speichern einer neuen Mitteilung aufrufen; wirft nie. Der Push nennt die Einheit, nie den Text und nie die Autorin oder den Autor: Er steht je nach Handy auf dem gesperrten Bildschirm und läuft über Apple und Google
export async function pushInfokanal(
  { db, fcm, c }: { db: Db; fcm?: Fcm; c?: Context },
  { einheitId, autorId }: { einheitId: string; autorId: string },
): Promise<void> {
  try {
    const [zeile] = await db
      .select({ name: einheit.name })
      .from(einheit)
      .where(eq(einheit.id, einheitId));
    if (!zeile) return;
    const konten = await empfaenger(db, einheitId, autorId);
    if (konten.length === 0) return;
    await sendePush({ db, fcm, c }, konten, {
      typ: "infokanal",
      kanal: "infokanal",
      id: einheitId,
      titel: `Neue Mitteilung im Infokanal ${zeile.name}`,
    });
  } catch (fehler) {
    // Nur der Code: message enthielte die SQL-Parameter
    log(c, { ereignis: "push", code: fehlerCode(fehler) });
  }
}

// Wie lange eine Mitteilung bleibt, gelöschte Platzhalter eingeschlossen
const AUFBEWAHRUNG = "6 months";

// Löscht Mitteilungen ab 6 Monaten ganz; der Lesestand je Konto bleibt (eine Zeile je Konto und Einheit, ohne Inhalt)
export async function loescheAlteMitteilungen(db: Db) {
  const geloescht = await db
    .delete(infokanalMitteilung)
    .where(
      lt(
        infokanalMitteilung.erstelltAm,
        roh`now() - ${AUFBEWAHRUNG}::interval`,
      ),
    )
    .returning({ id: infokanalMitteilung.id });
  return geloescht.length;
}

// Startet den Lauf sofort und dann alle 24 Stunden; ins Log kommt nur die Anzahl, bei einem Fehler nur sein Code
export function starteInfokanalAufraeumen(lauf: () => Promise<number>) {
  const starte = () =>
    lauf()
      .then((anzahl) =>
        log(undefined, { ereignis: "infokanal", geloescht: anzahl }),
      )
      .catch((fehler) =>
        log(undefined, {
          ereignis: "infokanal",
          code: fehlerCode(fehler) ?? "unerwartet",
        }),
      );
  void starte();
  return setInterval(starte, 24 * 60 * 60 * 1000);
}
