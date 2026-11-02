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

type Umgebung = { db: Db; fcm?: Fcm; c?: Context };

// Der Text nennt weder Termin noch Person: Der Push steht je nach Handy auf dem gesperrten Bildschirm, und er läuft über Apple und Google
const TEXT = "In Fire-Response";

// Konten, die der Push erreicht: Eltern und teilnehmende Personen aktiver Teilnehmender der Einheit sowie Kommando und Leitende; aktives Konto, Schalter pushProgramme an. Mit nurAntworten nur, wer für dieses Programm schon geantwortet hat (ja oder nein)
async function empfaenger(
  db: Db,
  programmId: string,
  einheitId: string,
  nurAntworten: boolean,
) {
  const eltern = await db
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
  { db, fcm, c }: Umgebung,
  programmId: string,
  titel: string,
  nurAntworten: boolean,
) {
  try {
    // Nur künftige Programme: Für ein begonnenes ist jede Meldung zu spät
    const [zeile] = await db
      .select({ einheitId: programm.einheitId })
      .from(programm)
      .where(and(eq(programm.id, programmId), roh`${programmBeginn} > now()`));
    if (!zeile) return;
    const konten = await empfaenger(
      db,
      programmId,
      zeile.einheitId,
      nurAntworten,
    );
    if (konten.length === 0) return;
    await sendePush({ db, fcm, c }, konten, {
      typ: "programm",
      kanal: "termine",
      id: programmId,
      titel,
      text: TEXT,
    });
  } catch (fehler) {
    // Nur der Code: message enthielte die SQL-Parameter
    log(c, { ereignis: "push", code: (fehler as { code?: unknown }).code });
  }
}

// Nach dem Absagen eines künftigen Programms aufrufen. Geht an alle der Einheit (Eltern, teilnehmende Personen, Kommando, Leitende), auch ohne Antwort: Wer nicht abgesagt hat, käme sonst vergeblich
export const sendeAbsagePush = (umgebung: Umgebung, programmId: string) =>
  pushAnTermin(umgebung, programmId, "Termin abgesagt", false);

// Nach der Änderung eines künftigen Programms aufrufen. Geht nur an Personen, die schon geantwortet haben; hat noch niemand geantwortet, geschieht nichts (der Sync übernimmt die Änderung still)
export const sendeAenderungsPush = (umgebung: Umgebung, programmId: string) =>
  pushAnTermin(umgebung, programmId, "Termin geändert", true);
