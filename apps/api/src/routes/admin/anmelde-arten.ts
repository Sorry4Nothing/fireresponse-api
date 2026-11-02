import { asc, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { auditLog, einheit, programm } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import { pruefeEinheit, type Person } from "../../rechte.js";

const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const auswahlSchema = z.strictObject({
  arten: z.array(z.string().min(1).max(100)).max(50),
});

// Welche Arten von Terminen (Spalte «Art» in Lodur) die Anmeldung anbieten. Die Arten kommen aus den synchronisierten Terminen der Einheit; bis die Verwaltung entschieden hat, ist keine Art anmeldbar
export function erstelleAnmeldeArtenRouten({ db }: { db: Db }) {
  async function stand(einheitId: string) {
    const [e] = await db
      .select({ gewaehlt: einheit.anmeldeArten })
      .from(einheit)
      .where(eq(einheit.id, einheitId));
    const gefunden = await db
      .select({ art: programm.art, anzahl: count() })
      .from(programm)
      .where(eq(programm.einheitId, einheitId))
      .groupBy(programm.art)
      .orderBy(asc(programm.art));
    const gewaehlt = e!.gewaehlt ?? [];
    const anzahl = new Map(gefunden.map((z) => [z.art, z.anzahl]));
    // Eine gewählte Art ohne Termine (mehr) bleibt in der Liste, damit sie sich abwählen lässt
    const arten = [...new Set([...anzahl.keys(), ...gewaehlt])]
      .filter((a): a is string => a !== null)
      .sort((a, b) => a.localeCompare(b, "de"))
      .map((art) => ({
        art,
        anzahl: anzahl.get(art) ?? 0,
        anmeldbar: gewaehlt.includes(art),
      }));
    return { entschieden: e!.gewaehlt !== null, arten };
  }

  return new Hono<{ Variables: { person: Person } }>()
    .get("/", eingabe("param", einheitPfad), async (c) => {
      const { einheitId } = c.req.valid("param");
      await pruefeEinheit(db, c.get("person"), einheitId, "verwalten");
      return c.json(await stand(einheitId));
    })
    .put(
      "/",
      eingabe("param", einheitPfad),
      eingabe("json", auswahlSchema),
      async (c) => {
        const person = c.get("person");
        const { einheitId } = c.req.valid("param");
        await pruefeEinheit(db, person, einheitId, "verwalten");
        const arten = [...new Set(c.req.valid("json").arten)].sort();
        // Nur Arten, die es bei der Einheit gibt (oder gab und noch gewählt sind): Die Liste ist keine freie Eingabe
        const bekannt = new Set(
          (await stand(einheitId)).arten.map((a) => a.art),
        );
        if (arten.some((a) => !bekannt.has(a))) {
          return c.json(
            {
              code: "ART_UNBEKANNT",
              message: "Eine Art kommt bei dieser Einheit nicht vor.",
            },
            400,
          );
        }
        await db.transaction(async (tx) => {
          await tx
            .update(einheit)
            .set({ anmeldeArten: arten })
            .where(eq(einheit.id, einheitId));
          await tx.insert(auditLog).values({
            einheitId,
            akteurId: person.id,
            aktion: "anmelde_arten_gesetzt",
            zielTyp: "einheit",
            zielId: einheitId,
            details: { arten },
          });
        });
        return c.json(await stand(einheitId));
      },
    );
}
