import { and, asc, eq, exists, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import {
  bezirk,
  einheit,
  einheitRolle,
  rang,
  teilnahme,
  teilnehmende,
  user,
} from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import { protokolliere, type Tx } from "../../konten.js";
import { aktivesKonto, pruefeEinheit, type Person } from "../../rechte.js";

const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const zielPfad = z.strictObject({
  einheitId: z.uuid(),
  teilnehmendeId: z.uuid(),
});
const uebertragenSchema = z.strictObject({ zielEinheitId: z.uuid() });

// Eine Einheit gilt als in der App registriert, wenn sie ein aktives Kommando-Konto hat
const registriert = (db: Pick<Db, "select">) =>
  exists(
    db
      .select({ eins: sql`1` })
      .from(einheitRolle)
      .innerJoin(user, eq(user.id, einheitRolle.userId))
      .where(
        and(
          eq(einheitRolle.einheitId, einheit.id),
          eq(einheitRolle.typ, "kommandant"),
          aktivesKonto(),
        ),
      ),
  );

// Die Einheiten, in die die Person Kinder der Einheit übertragen darf. Das Kommando (und die Stellvertretung) der KF überträgt nur in die JF desselben Bezirks; jede andere Übertragung macht allein das Kantonsadmin-Konto. Ziel ist immer eine registrierte Einheit
async function ziele(
  db: Pick<Db, "select">,
  person: Person,
  quelle: { id: string; typ: "jf" | "kf"; bezirkId: string },
) {
  const erlaubt = person.kantonsadmin
    ? sql`true`
    : quelle.typ === "kf"
      ? and(eq(einheit.bezirkId, quelle.bezirkId), eq(einheit.typ, "jf"))
      : sql`false`;
  return db
    .select({
      id: einheit.id,
      name: einheit.name,
      typ: einheit.typ,
      bezirk: bezirk.name,
    })
    .from(einheit)
    .innerJoin(bezirk, eq(bezirk.id, einheit.bezirkId))
    .where(and(ne(einheit.id, quelle.id), erlaubt, registriert(db)))
    .orderBy(asc(bezirk.name), asc(einheit.typ));
}

async function ladeQuelle(db: Pick<Db, "select">, einheitId: string) {
  const [zeile] = await db
    .select({ id: einheit.id, typ: einheit.typ, bezirkId: einheit.bezirkId })
    .from(einheit)
    .where(eq(einheit.id, einheitId));
  if (!zeile) throw new HTTPException(404);
  return zeile;
}

export function erstelleUebertragungRouten({ db }: { db: Db }) {
  return (
    new Hono<{ Variables: { person: Person } }>()
      // Die erlaubten Zieleinheiten für die Auswahl im Panel; leer, wenn die Person aus dieser Einheit nicht übertragen darf
      .get("/ziele", eingabe("param", einheitPfad), async (c) => {
        const person = c.get("person");
        const { einheitId } = c.req.valid("param");
        await pruefeEinheit(db, person, einheitId, "verwalten");
        return c.json({
          ziele: await ziele(db, person, await ladeQuelle(db, einheitId)),
        });
      })
      // Ändert nur die Einheit (und den Rang) der Person. Konten und Eltern bleiben; Antworten in der alten Einheit verfallen. Alles in einer Transaktion
      .post(
        "/:teilnehmendeId/uebertragen",
        eingabe("param", zielPfad),
        eingabe("json", uebertragenSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId, teilnehmendeId } = c.req.valid("param");
          const { zielEinheitId } = c.req.valid("json");
          await pruefeEinheit(db, person, einheitId, "verwalten");
          await db.transaction(async (tx: Tx) => {
            // Zeilensperre: zwei gleichzeitige Übertragungen laufen nacheinander. Eine Person einer anderen Einheit ist 404
            const [ziel] = await tx
              .select({ id: teilnehmende.id })
              .from(teilnehmende)
              .where(
                and(
                  eq(teilnehmende.id, teilnehmendeId),
                  eq(teilnehmende.einheitId, einheitId),
                ),
              )
              .for("no key update");
            if (!ziel) throw new HTTPException(404);
            const quelle = await ladeQuelle(tx, einheitId);
            // Nicht erlaubt oder nicht registriert: für das Kommando 403, ohne zu verraten, ob die Einheit existiert; der Kantonsadmin bekommt 400
            const erlaubte = await ziele(tx, person, quelle);
            if (!erlaubte.some((z) => z.id === zielEinheitId)) {
              throw new HTTPException(person.kantonsadmin ? 400 : 403);
            }
            // Antworten gelten in der Einheit des Programms; in der neuen Einheit gibt es sie nicht und in der alten keine Person mehr, also auch vergangene weg
            const geloescht = await tx
              .delete(teilnahme)
              .where(eq(teilnahme.teilnehmendeId, teilnehmendeId))
              .returning({ programmId: teilnahme.programmId });
            // Ein Rang gehört einer Einheit: Mit gleichem Namen und Typ in der Zieleinheit geht er mit, sonst bleibt die Person ohne Rang
            const neuerRang = sql`(select r2.id from ${rang} r1 join ${rang} r2 on r2.name = r1.name and r2.typ = r1.typ and r2.einheit_id = ${zielEinheitId} where r1.id = ${teilnehmende.rangId} and r1.einheit_id = ${einheitId})`;
            await tx
              .update(teilnehmende)
              .set({ einheitId: zielEinheitId, rangId: neuerRang })
              .where(eq(teilnehmende.id, teilnehmendeId));
            // Nur IDs und die Zahl, nie ein Name
            await protokolliere(tx, {
              einheitId,
              akteurId: person.id,
              aktion: "teilnehmende_uebertragen",
              zielTyp: "teilnehmende",
              zielId: teilnehmendeId,
              details: {
                vonEinheitId: einheitId,
                nachEinheitId: zielEinheitId,
                geloeschteAntworten: geloescht.length,
              },
            });
          });
          return c.body(null, 204);
        },
      )
  );
}
