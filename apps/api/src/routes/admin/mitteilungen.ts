import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { ZU_VIELE_ANFRAGEN } from "../../auth.js";
import type { Db } from "../../db/client.js";
import {
  auditLog,
  einheitRolle,
  pushToken,
  teilnehmende,
  teilnehmendeKonto,
  user,
} from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import { type Fcm, sendePush } from "../../push.js";
import { aktivesKonto, pruefeEinheit, type Person } from "../../rechte.js";

// Der Push steht je nach Handy auf dem gesperrten Bildschirm und läuft über Google und Apple: kurz, nur Text
export const MAX_TITEL = 60;
export const MAX_TEXT = 200;
// Höchstens so viele Mitteilungen je Konto, gezählt im Audit-Log (überlebt Neustarts und gilt für alle Instanzen)
export const LIMIT_STUNDE = 5;
export const LIMIT_TAG = 20;
export const AKTION = "push_mitteilung_gesendet";

// Nach Unicode-Zeichen gezählt, wie die App sie zählt, nicht nach UTF-16-Einheiten
const kurz = (max: number) => (wert: string) => [...wert].length <= max;
// Titel in einer Zeile; im Text sind Zeilenumbrüche erlaubt, sonst keine Steuerzeichen
const einzeilig = /^\P{Cc}+$/u;
const mehrzeilig = /^(?:\P{Cc}|\n)+$/u;

// einheitId steht im Pfad der Verwaltung: Sie kommt vom Umschalter, nie aus dem Body
const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const sendenSchema = z.strictObject({
  gruppe: z.enum(["alle", "leitende"]),
  titel: z.string().trim().regex(einzeilig).refine(kurz(MAX_TITEL)),
  text: z.string().trim().regex(mehrzeilig).refine(kurz(MAX_TEXT)),
});

// Aktive Konten der Einheit mit mindestens einem Push-Token. «leitende»: Kommando, Stellvertretung und Leitende; «alle» dazu die Eltern und teilnehmenden Personen aktiver Teilnehmender. Kein Schalter der Konten: Er gilt für Programme, nicht für Mitteilungen der Verwaltung
async function erreichbareKonten(
  db: Db,
  einheitId: string,
  gruppe: "alle" | "leitende",
) {
  const leitende = await db
    .selectDistinct({ id: user.id })
    .from(einheitRolle)
    .innerJoin(user, and(eq(user.id, einheitRolle.userId), aktivesKonto()))
    .where(eq(einheitRolle.einheitId, einheitId));
  const eltern =
    gruppe === "leitende"
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
            and(eq(user.id, teilnehmendeKonto.userId), aktivesKonto()),
          )
          .where(
            and(
              eq(teilnehmende.einheitId, einheitId),
              isNull(teilnehmende.inaktivSeit),
            ),
          );
  const konten = [...new Set([...leitende, ...eltern].map(({ id }) => id))];
  if (konten.length === 0) return [];
  const mitToken = await db
    .selectDistinct({ id: pushToken.userId })
    .from(pushToken)
    .where(inArray(pushToken.userId, konten));
  return mitToken.map(({ id }) => id);
}

// Freier Push-Text aus der Verwaltung. Nur Kantonsadmin, Kommandant und Stellvertretungen der Einheit (wie die übrige Verwaltung); Leitende und Eltern bekommen 403. Gesendet wird sofort, ohne Wiederholung und Planung. Der Text steht nie im Audit-Log und nie im Anfrage-Log
export function erstelleMitteilungsRouten({ db, fcm }: { db: Db; fcm?: Fcm }) {
  return new Hono<{ Variables: { person: Person } }>().post(
    "/",
    eingabe("param", einheitPfad),
    eingabe("json", sendenSchema),
    async (c) => {
      const person = c.get("person");
      const { einheitId } = c.req.valid("param");
      const { gruppe, titel, text } = c.req.valid("json");
      await pruefeEinheit(db, person, einheitId, "verwalten");
      // Ohne Schlüssel des Push-Dienstes ginge nichts hinaus; das Protokoll soll dann keinen Versand behaupten
      if (!fcm) {
        return c.json(
          {
            code: "PUSH_NICHT_EINGERICHTET",
            message:
              "Der Push-Dienst ist auf diesem Server nicht eingerichtet.",
          },
          503,
        );
      }
      const konten = await erreichbareKonten(db, einheitId, gruppe);
      if (konten.length === 0) return c.json({ empfaenger: 0 });

      const frei = await db.transaction(async (tx) => {
        // Eine Sperre je Konto, damit gleichzeitige Anfragen das Limit nicht umgehen
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${AKTION}:${person.id}`}))`,
        );
        const [z] = await tx
          .select({
            stunde: sql<number>`count(*) filter (where ${auditLog.erstelltAm} > now() - interval '1 hour')::int`,
            tag: sql<number>`count(*)::int`,
          })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.akteurId, person.id),
              eq(auditLog.aktion, AKTION),
              gt(auditLog.erstelltAm, sql`now() - interval '1 day'`),
            ),
          );
        if (z!.stunde >= LIMIT_STUNDE || z!.tag >= LIMIT_TAG) return false;
        // Vor dem Versand, in derselben Sperre: Nie der Text, nur Einheit, Gruppe und Zahl
        await tx.insert(auditLog).values({
          einheitId,
          akteurId: person.id,
          aktion: AKTION,
          zielTyp: "einheit",
          zielId: einheitId,
          details: { gruppe, konten: konten.length },
        });
        return true;
      });
      if (!frei) return c.json(ZU_VIELE_ANFRAGEN, 429);

      // Wirft nie; ein Fehler des Dienstes steht als Code im Log
      await sendePush({ db, fcm, c }, konten, {
        typ: "mitteilung",
        kanal: "termine",
        titel,
        text,
      });
      return c.json({ empfaenger: konten.length });
    },
  );
}
