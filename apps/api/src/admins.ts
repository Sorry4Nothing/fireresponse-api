import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { abteilung, user } from "./db/schema.js";

// Serialisiert das Entfernen von Admins einer Abteilung (#18): erst die Abteilungszeile sperren, dann zählen.
// Zwei Statements, weil unter READ COMMITTED nur ein nach dem Warten gestartetes Statement den fremden Commit sieht.
// «no key update» statt «for update»: Fremdschlüssel-Prüfungen anderer Verbindungen nehmen «key share» und warteten sonst
export async function aktiveAdminIds(
  tx: Pick<Db, "select">,
  abteilungId: string,
) {
  await tx
    .select({ id: abteilung.id })
    .from(abteilung)
    .where(eq(abteilung.id, abteilungId))
    .for("no key update");
  const zeilen = await tx
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.abteilungId, abteilungId),
        eq(user.role, "admin"),
        // banned ist nullable, «is not true» zählt auch null als aktiv
        sql`${user.banned} is not true`,
      ),
    );
  return zeilen.map((zeile) => zeile.id);
}

// Ziel gelistet und keine zweite aktive Admin-ID: der letzte Admin bleibt
export function istLetzterAdmin(admins: readonly string[], zielId: string) {
  return admins.includes(zielId) && !admins.some((id) => id !== zielId);
}

// Der Text, den die App kennt (fehlertexte.ts); die Verwaltung antwortet damit
export const LETZTER_ADMIN = {
  code: "LETZTER_ADMIN",
  message: "Der letzte Admin lässt sich nicht entfernen.",
} as const;
