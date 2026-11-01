import { and, eq, inArray, ne } from "drizzle-orm";
import type { Context } from "hono";
import type { Db } from "./db/client.js";
import { programm, programmStufe, rolle, user } from "./db/schema.js";
import { programmTag } from "./programm-tag.js";
import { log } from "./log.js";
import { type Fcm, sendePush } from "./push.js";
import { aktivesKonto } from "./rechte.js";

const WOCHENTAG = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

// «Sa 31.10.»: Der Tag kommt als Schweizer Datum (yyyy-mm-dd) aus programmTag, nie über die Zone des Servers
export function kurzDatum(tag: string) {
  const [, monat, tagNr] = tag.split("-").map(Number);
  const wochentag = new Date(`${tag}T12:00:00Z`).getUTCDay();
  return `${WOCHENTAG[wochentag]} ${tagNr}.${monat}.`;
}

// Nach dem Speichern der Teilnahme aufrufen; wirft nie: Ein Fehler hier darf die Anmeldung nicht scheitern lassen
// Der Text nennt Programm und Datum, nie das Kind: Der Push steht je nach Handy auf dem gesperrten Bildschirm
export async function pushAnmeldung(
  { db, fcm, c }: { db: Db; fcm?: Fcm; c?: Context },
  {
    programmId,
    abteilungId,
    userId,
    status,
  }: {
    programmId: string;
    abteilungId: string;
    userId: string;
    status: "ja" | "nein";
  },
): Promise<void> {
  try {
    const [zeile] = await db
      .select({
        titel: programm.titel,
        tagVon: programm.tagVon,
        beginn: programm.beginn,
      })
      .from(programm)
      .where(
        and(eq(programm.id, programmId), eq(programm.abteilungId, abteilungId)),
      );
    if (!zeile) return;
    // Leitende der Stufen des Programms; wer selbst ändert, weiss es schon
    const leitende = await db
      .selectDistinct({ id: user.id })
      .from(rolle)
      .innerJoin(user, eq(user.id, rolle.userId))
      .where(
        and(
          inArray(
            rolle.stufeId,
            db
              .select({ id: programmStufe.stufeId })
              .from(programmStufe)
              .where(eq(programmStufe.programmId, programmId)),
          ),
          aktivesKonto(abteilungId),
          eq(user.pushAnmeldungen, true),
          ne(user.id, userId),
        ),
      );
    if (leitende.length === 0) return;
    await sendePush(
      { db, fcm, c },
      leitende.map(({ id }) => id),
      {
        typ: "programm",
        id: programmId,
        titel: status === "ja" ? "Neue Anmeldung" : "Neue Abmeldung",
        text: `${zeile.titel} am ${kurzDatum(programmTag(zeile))}`,
      },
    );
  } catch (fehler) {
    // Nur der Code: message enthielte die SQL-Parameter
    log(c, { ereignis: "push", code: (fehler as { code?: unknown }).code });
  }
}
