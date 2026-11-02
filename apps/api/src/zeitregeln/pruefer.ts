import { and, eq, isNull, notExists, sql as roh } from "drizzle-orm";
import { verbindeDatenbank } from "../datenbank.js";
import { erstelleDb, type Db } from "../db/client.js";
import {
  einheitRolle,
  leitungAnmeldung,
  programm,
  teilnahme,
  teilnehmende,
  teilnehmendeKonto,
  user,
  zeitregel,
  zeitregelGesendet,
} from "../db/schema.js";
import { fehlerCode, log } from "../log.js";
import { type Fcm, sendePush } from "../push.js";
import {
  ANMELDEFENSTER_STANDARD,
  anmeldbar,
  fensterOffen,
} from "../anmeldefenster.js";
import { aktivesKonto, programmBeginn } from "../rechte.js";
import { ausloesezeit, kurzDatum } from "./ausloesezeit.js";

// Eigener Schlüssel für die Sperre; 740027 und 740028 bleiben für spätere Hintergrundläufe frei
const SPERRE_ZEITREGELN = 740_029;
// Die Auslösezeit liegt höchstens 7 Tage (plus eine Stunde Umstellung) vor dem Beginn; weiter entfernte Programme sind nie fällig
const VORLAUF_MS = 8 * 86_400_000;

// Titel und Beschreibung der Regel; die Platzhalter ersetzt der Server, nie Namen
export const titelAusRegel = (
  text: string,
  programmTitel: string,
  beginn: Date,
) =>
  text
    .replaceAll("{Programm}", programmTitel)
    .replaceAll("{Datum}", kurzDatum(beginn));

// Sendet jede fällige Erinnerung genau einmal: Die Zeile in zeitregel_gesendet entsteht vor dem Versand (INSERT … ON CONFLICT DO NOTHING ist die Sperre, auch bei zwei Servern). Stürzt der Prozess dazwischen ab, fällt diese eine Erinnerung aus, doppelt kommt sie nie.
// Fällig heisst: Auslösezeit erreicht und das Programm hat noch nicht begonnen; ein Lauf nach einem Ausfall holt sie damit nach
// Nur für Programme im Anmeldefenster (`anmeldefensterTage`): Vorher lässt sich nicht antworten, eine Erinnerung wäre sinnlos
export async function sendeFaelligeErinnerungen(
  {
    db,
    fcm,
    anmeldefensterTage = ANMELDEFENSTER_STANDARD,
  }: { db: Db; fcm: Fcm; anmeldefensterTage?: number },
  jetzt: Date,
) {
  // Nur Programme, die noch Anmeldungen annehmen (wie teilnahmeOffen)
  const programme = await db
    .select({
      id: programm.id,
      einheitId: programm.einheitId,
      titel: programm.titel,
      // Millisekunden statt Zeitstempel: Der Treiber liefert Zeitstempel als Text
      beginnMs: roh<string>`(extract(epoch from ${programmBeginn}) * 1000)::bigint`,
    })
    .from(programm)
    .where(
      and(
        eq(programm.status, "aktiv"),
        roh`${programmBeginn} > ${jetzt.toISOString()}`,
        roh`${programmBeginn} <= ${new Date(jetzt.getTime() + VORLAUF_MS).toISOString()}`,
        fensterOffen(anmeldefensterTage, jetzt),
        anmeldbar,
      ),
    );
  if (programme.length === 0) return;
  const regeln = await db
    .select()
    .from(zeitregel)
    .where(eq(zeitregel.aktiv, true));
  if (regeln.length === 0) return;

  for (const p of programme) {
    const beginn = new Date(Number(p.beginnMs));
    for (const regel of regeln) {
      if (regel.einheitId !== p.einheitId) continue;
      if (ausloesezeit(beginn, regel.wochentag, regel.uhrzeit) > jetzt)
        continue;
      try {
        const [neu] = await db
          .insert(zeitregelGesendet)
          .values({ regelId: regel.id, programmId: p.id })
          .onConflictDoNothing()
          .returning({ regelId: zeitregelGesendet.regelId });
        if (!neu) continue;
        // Konten aktiver Teilnehmender der Einheit ohne gespeichertes «ja» oder «nein», dazu Kommando und Leitende ohne Anmeldung; wer mehrere Kinder offen hat, kommt einmal vor
        const ohneAntwort = await db
          .selectDistinct({ id: user.id })
          .from(teilnehmende)
          .innerJoin(
            teilnehmendeKonto,
            eq(teilnehmendeKonto.teilnehmendeId, teilnehmende.id),
          )
          .innerJoin(
            user,
            and(
              eq(user.id, teilnehmendeKonto.userId),
              aktivesKonto(),
              eq(user.pushProgramme, true),
            ),
          )
          .where(
            and(
              eq(teilnehmende.einheitId, p.einheitId),
              isNull(teilnehmende.inaktivSeit),
              notExists(
                db
                  .select({ eins: roh`1` })
                  .from(teilnahme)
                  .where(
                    and(
                      eq(teilnahme.teilnehmendeId, teilnehmende.id),
                      eq(teilnahme.programmId, p.id),
                    ),
                  ),
              ),
            ),
          );
        const leitungOhneAntwort = await db
          .selectDistinct({ id: user.id })
          .from(einheitRolle)
          .innerJoin(
            user,
            and(
              eq(user.id, einheitRolle.userId),
              aktivesKonto(),
              eq(user.pushProgramme, true),
            ),
          )
          .where(
            and(
              eq(einheitRolle.einheitId, p.einheitId),
              notExists(
                db
                  .select({ eins: roh`1` })
                  .from(leitungAnmeldung)
                  .where(
                    and(
                      eq(leitungAnmeldung.userId, user.id),
                      eq(leitungAnmeldung.programmId, p.id),
                    ),
                  ),
              ),
            ),
          );
        const eltern = [
          ...new Map(
            [...ohneAntwort, ...leitungOhneAntwort].map((z) => [z.id, z]),
          ).values(),
        ];
        if (eltern.length === 0) continue;
        await sendePush(
          { db, fcm },
          eltern.map((e) => e.id),
          {
            typ: "programm",
            kanal: "termine",
            id: p.id,
            titel: titelAusRegel(regel.text, p.titel, beginn),
            ...(regel.beschreibung && {
              text: titelAusRegel(regel.beschreibung, p.titel, beginn),
            }),
          },
        );
      } catch (fehler) {
        // Nur der Code: message enthielte die SQL-Parameter; die nächste Regel läuft weiter
        log(undefined, {
          ereignis: "zeitregel",
          code: fehlerCode(fehler),
        });
      }
    }
  }
}

// Ein Lauf; «gesperrt» heisst: ein anderer Lauf arbeitet gerade
export async function pruefeZeitregeln({
  datenbankUrl,
  fcm,
  anmeldefensterTage,
  jetzt = new Date(),
}: {
  datenbankUrl: string;
  fcm: Fcm;
  anmeldefensterTage?: number;
  jetzt?: Date;
}): Promise<"fertig" | "gesperrt"> {
  // Eigene Verbindung mit max 1: Sperre und Freigabe müssen auf derselben Sitzung laufen
  const sql = verbindeDatenbank(datenbankUrl, { max: 1 });
  try {
    const [sperre] =
      await sql`select pg_try_advisory_lock(${SPERRE_ZEITREGELN}) as erhalten`;
    if (!sperre.erhalten) return "gesperrt";
    try {
      await sendeFaelligeErinnerungen(
        { db: erstelleDb(sql), fcm, anmeldefensterTage },
        jetzt,
      );
      return "fertig";
    } finally {
      // Scheitert nur mit der Verbindung, und dann fällt die Sperre mit ihr
      await sql`select pg_advisory_unlock(${SPERRE_ZEITREGELN})`.catch(
        () => {},
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Startet den Lauf sofort und dann jede Minute; Erfolg und «gesperrt» bleiben still
export function starteZeitregelPruefer(lauf: () => Promise<unknown>) {
  const starte = () =>
    lauf().catch((fehler) =>
      log(undefined, { ereignis: "zeitregel", code: fehlerCode(fehler) }),
    );
  void starte();
  return setInterval(starte, 60 * 1000);
}
