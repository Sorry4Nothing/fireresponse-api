import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { auditLog, einheit } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import {
  LodurFehler,
  maskiere,
  pruefeLodurUrl,
  ZWECK_LODUR_LINK,
} from "../../lodur-url.js";
import { pruefeEinheit, type Person } from "../../rechte.js";
import { entschluessele, verschluessele } from "../../startpasswort.js";

const einheitPfad = z.strictObject({ einheitId: z.uuid() });
// Die Länge prüft pruefeLodurUrl; hier nur eine Grenze, bevor der Text weiterläuft
const linkSchema = z.strictObject({ url: z.string().min(1).max(4096) });

const UNGUELTIG = {
  code: "LODUR_LINK_UNGUELTIG",
  message: "Der Link ist ungültig oder der Host nicht erlaubt.",
} as const;

// Der Link verlässt die API nie im Klartext: Nach dem Speichern nennt sie nur den Host
export function erstelleLodurRouten({
  db,
  erlaubteHosts,
}: {
  db: Db;
  erlaubteHosts: readonly string[];
}) {
  async function stand(einheitId: string) {
    const [e] = await db
      .select({
        verschluesselt: einheit.lodurUrlVerschluesselt,
        syncOkAm: einheit.syncOkAm,
        syncFehler: einheit.syncFehler,
      })
      .from(einheit)
      .where(eq(einheit.id, einheitId));
    const link = entschluessele(e!.verschluesselt, ZWECK_LODUR_LINK);
    return {
      gesetzt: e!.verschluesselt !== null,
      maskiert: link === null ? null : maskiere(link),
      syncOkAm: e!.syncOkAm,
      syncFehler: e!.syncFehler,
    };
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
      eingabe("json", linkSchema),
      async (c) => {
        const person = c.get("person");
        const { einheitId } = c.req.valid("param");
        const { url } = c.req.valid("json");
        await pruefeEinheit(db, person, einheitId, "verwalten");
        try {
          pruefeLodurUrl(url, erlaubteHosts);
        } catch (fehler) {
          if (fehler instanceof LodurFehler) return c.json(UNGUELTIG, 400);
          throw fehler;
        }
        await db.transaction(async (tx) => {
          // Ein neuer Link beginnt ohne Stand; der nächste Lauf holt den Kalender
          await tx
            .update(einheit)
            .set({
              lodurUrlVerschluesselt: verschluessele(url, ZWECK_LODUR_LINK),
              lodurUrlGesetztAm: new Date(),
              syncOkAm: null,
              syncFehler: null,
            })
            .where(eq(einheit.id, einheitId));
          // Ohne den Link
          await tx.insert(auditLog).values({
            einheitId,
            akteurId: person.id,
            aktion: "lodur_link_gesetzt",
            zielTyp: "einheit",
            zielId: einheitId,
          });
        });
        return c.json(await stand(einheitId));
      },
    )
    .delete("/", eingabe("param", einheitPfad), async (c) => {
      const person = c.get("person");
      const { einheitId } = c.req.valid("param");
      await pruefeEinheit(db, person, einheitId, "verwalten");
      await db.transaction(async (tx) => {
        // Die Termine bleiben; es kommen keine neuen
        await tx
          .update(einheit)
          .set({
            lodurUrlVerschluesselt: null,
            lodurUrlGesetztAm: null,
            syncOkAm: null,
            syncFehler: null,
          })
          .where(eq(einheit.id, einheitId));
        await tx.insert(auditLog).values({
          einheitId,
          akteurId: person.id,
          aktion: "lodur_link_entfernt",
          zielTyp: "einheit",
          zielId: einheitId,
        });
      });
      return c.body(null, 204);
    });
}
