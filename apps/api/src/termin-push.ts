import { and, eq, exists, isNull, sql as roh } from "drizzle-orm";
import type { Context } from "hono";
import type { Db } from "./db/client.js";
import {
  einheitRolle,
  leitungAnmeldung,
  programm,
  teilnahme,
  teilnehmende,
  teilnehmendeKonto,
  user,
} from "./db/schema.js";
import { log } from "./log.js";
import { type Fcm, sendePush } from "./push.js";
import { aktivesKonto, programmBeginn } from "./rechte.js";
import { kurzDatum } from "./zeitregeln/ausloesezeit.js";

// jetzt gibt der Sync vor, dessen Lauf eine feste Zeit hat; sonst gilt die Uhr der Datenbank
type Umgebung = { db: Db; fcm?: Fcm; c?: Context; jetzt?: Date };

// Der Push steht je nach Handy auf dem gesperrten Bildschirm und läuft über Apple und Google. Titel und Tag des Programms dürfen darin stehen (wie bei den Erinnerungen); Namen von Personen, Antworten und Orte nie
const MAX_TITEL = 60;

// Lange Programmtitel kürzen, damit der Push nicht überläuft
const gekuerzt = (titel: string) => {
  const zeichen = [...titel];
  return zeichen.length > MAX_TITEL
    ? `${zeichen.slice(0, MAX_TITEL - 1).join("")}…`
    : titel;
};

// «Waldtag am Sa 6.3.» für Pushes zu einem Programm; beginnMs ist programmBeginnMs
export const titelMitTag = (titel: string, beginnMs: string) =>
  `${gekuerzt(titel)} am ${kurzDatum(new Date(Number(beginnMs)))}`;

// Millisekunden statt Zeitstempel: Der Treiber liefert Zeitstempel als Text
export const programmBeginnMs = roh<string>`(extract(epoch from ${programmBeginn}) * 1000)::bigint`;

// Konten, die der Push erreicht: Eltern und teilnehmende Personen aktiver Teilnehmender der Einheit sowie Kommando und Leitende; aktives Konto, Schalter pushProgramme an. Mit nurAntworten nur, wer für dieses Programm schon geantwortet hat (ja oder nein)
async function empfaenger(
  db: Db,
  programmId: string,
  einheitId: string,
  nurAntworten: boolean,
  nurLeitende: boolean,
) {
  // Bei «nur Leitende» erfahren Kinder und Eltern nichts vom Termin
  const eltern = nurLeitende
    ? []
    : await db
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
            eq(teilnehmende.einheitId, einheitId),
            isNull(teilnehmende.inaktivSeit),
            nurAntworten
              ? exists(
                  db
                    .select({ eins: roh`1` })
                    .from(teilnahme)
                    .where(
                      and(
                        eq(teilnahme.teilnehmendeId, teilnehmende.id),
                        eq(teilnahme.programmId, programmId),
                      ),
                    ),
                )
              : undefined,
          ),
        );
  const leitende = await db
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
        eq(einheitRolle.einheitId, einheitId),
        nurAntworten
          ? exists(
              db
                .select({ eins: roh`1` })
                .from(leitungAnmeldung)
                .where(
                  and(
                    eq(leitungAnmeldung.userId, user.id),
                    eq(leitungAnmeldung.programmId, programmId),
                  ),
                ),
            )
          : undefined,
      ),
    );
  // Wer mehrere Rollen oder Kinder hat, kommt einmal vor
  return [...new Set([...eltern, ...leitende].map(({ id }) => id))];
}

// Wirft nie: Der Aufrufer (Lodur-Sync) hat die Änderung schon gespeichert, ein Fehler hier darf sie nicht wiederholen lassen
async function pushAnTermin(
  { db, fcm, c, jetzt }: Umgebung,
  programmId: string,
  was: "abgesagt" | "geändert",
  text: string,
  nurAntworten: boolean,
) {
  try {
    // Nur künftige Programme: Für ein begonnenes ist jede Meldung zu spät
    const [zeile] = await db
      .select({
        einheitId: programm.einheitId,
        titel: programm.titel,
        nurLeitende: programm.nurLeitende,
        beginnMs: programmBeginnMs,
      })
      .from(programm)
      .where(
        and(
          eq(programm.id, programmId),
          jetzt
            ? roh`${programmBeginn} > ${jetzt.toISOString()}::timestamptz`
            : roh`${programmBeginn} > now()`,
        ),
      );
    if (!zeile) return;
    const konten = await empfaenger(
      db,
      programmId,
      zeile.einheitId,
      nurAntworten,
      zeile.nurLeitende,
    );
    if (konten.length === 0) return;
    await sendePush({ db, fcm, c }, konten, {
      typ: "programm",
      kanal: "termine",
      id: programmId,
      titel: `${titelMitTag(zeile.titel, zeile.beginnMs)} ${was}`,
      text,
    });
  } catch (fehler) {
    // Nur der Code: message enthielte die SQL-Parameter
    log(c, { ereignis: "push", code: (fehler as { code?: unknown }).code });
  }
}

// Nach dem Absagen eines künftigen Programms aufrufen. Geht an alle der Einheit (Eltern, teilnehmende Personen, Kommando, Leitende), auch ohne Antwort: Wer nicht abgesagt hat, käme sonst vergeblich
export const sendeAbsagePush = (umgebung: Umgebung, programmId: string) =>
  pushAnTermin(
    umgebung,
    programmId,
    "abgesagt",
    "Mehr in Fire-Response.",
    false,
  );

// Nach der Änderung eines künftigen Programms aufrufen. Geht nur an Personen, die schon geantwortet haben; hat noch niemand geantwortet, geschieht nichts (der Sync übernimmt die Änderung still)
export const sendeAenderungsPush = (umgebung: Umgebung, programmId: string) =>
  pushAnTermin(
    umgebung,
    programmId,
    "geändert",
    "Bitte Zeit und Aufgebot in der App prüfen.",
    true,
  );
