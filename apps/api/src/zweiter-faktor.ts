import { and, eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { auditLog, twoFactor, user } from "./db/schema.js";

// Für die Route und die CLI; ohne node:* und process, denn die Route zieht diese Datei in AppType
// Gibt false zurück, wenn die Person keinen aktiven Faktor hat; dann ist nichts geschrieben
export async function setzeZweitenFaktorZurueck(
  db: Db,
  {
    zielId,
    abteilungId,
    akteurId,
  }: { zielId: string; abteilungId: string; akteurId: string },
) {
  return db.transaction(async (tx) => {
    // Das Flag zuerst und bedingt: Zwei gleichzeitige Zurücksetzungen schreiben nur eine Audit-Zeile
    const zurueckgesetzt = await tx
      .update(user)
      .set({ twoFactorEnabled: false })
      .where(
        and(
          eq(user.id, zielId),
          eq(user.abteilungId, abteilungId),
          eq(user.twoFactorEnabled, true),
        ),
      )
      .returning({ id: user.id });
    if (zurueckgesetzt.length === 0) return false;
    // Eine übrig gebliebene Zeile liesse das nächste enable mit TOTP_ALREADY_ENABLED scheitern
    await tx.delete(twoFactor).where(eq(twoFactor.userId, zielId));
    await tx.insert(auditLog).values({
      abteilungId,
      akteurId,
      aktion: "zweiter_faktor_zurueckgesetzt",
      zielTyp: "person",
      zielId,
    });
    return true;
  });
}
