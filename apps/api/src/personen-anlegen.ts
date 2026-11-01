import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { erstelleAuth, platzhalterEmail } from "./auth.js";
import type { Db } from "./db/client.js";
import * as schema from "./db/schema.js";
import { auditLog, kindEltern, rolle } from "./db/schema.js";
import type { Person } from "./rechte.js";
import {
  normalisiereStartpasswort,
  startpasswortFelder,
} from "./startpasswort.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface NeuePerson {
  vorname: string;
  nachname: string;
  telefon?: string | null;
  benutzername: string;
  admin: boolean;
  rollen: readonly { stufeId: string; typ: "leitung" | "stufenleitung" }[];
  elternteilVon: readonly string[];
  startpasswort: string;
}

// Legt Konto, Rollen, Eltern-Verknüpfungen und den Audit-Eintrag «person_angelegt» in der Transaktion des Aufrufers an; ein Fehler (auch HIBP) nimmt alles zurück
export async function legePersonAn(
  tx: Tx,
  akteur: Person,
  headers: Headers,
  eingaben: NeuePerson,
) {
  // createUser legt den User vor der HIBP-Prüfung an; die Transaktion nimmt bei jedem Fehler alles zurück, sonst hielte ein Konto ohne Passwort den Benutzernamen fest
  const txAuth = erstelleAuth(
    drizzleAdapter(tx, { provider: "pg", schema, transaction: true }),
  );
  const { user: neu } = await txAuth.api.createUser({
    body: {
      email: platzhalterEmail(),
      password: normalisiereStartpasswort(eingaben.startpasswort),
      name: `${eingaben.vorname} ${eingaben.nachname}`,
      role: eingaben.admin ? "admin" : "user",
      data: {
        username: eingaben.benutzername,
        abteilungId: akteur.abteilungId,
        ...startpasswortFelder(new Date(), eingaben.startpasswort),
      },
    },
    // Mit den Headern der Admin-Anfrage; ohne sie prüfte createUser keine Rechte
    headers,
  });
  if (eingaben.telefon) {
    await tx
      .update(schema.user)
      .set({ telefon: eingaben.telefon })
      .where(eq(schema.user.id, neu.id));
  }
  if (eingaben.rollen.length > 0) {
    await tx
      .insert(rolle)
      .values(eingaben.rollen.map((r) => ({ userId: neu.id, ...r })));
  }
  if (eingaben.elternteilVon.length > 0) {
    await tx
      .insert(kindEltern)
      .values(
        eingaben.elternteilVon.map((kindId) => ({ kindId, userId: neu.id })),
      );
  }
  // Im selben Commit wie die Aktion; details ohne Personendaten (IDs, Rollen, Flags)
  await tx.insert(auditLog).values({
    abteilungId: akteur.abteilungId,
    akteurId: akteur.id,
    aktion: "person_angelegt",
    zielTyp: "person",
    zielId: neu.id,
    details: {
      admin: eingaben.admin,
      rollen: eingaben.rollen,
      elternteilVon: eingaben.elternteilVon,
    },
  });
  // Das Plugin speichert kleingeschrieben; sein Typ kennt das Feld nicht
  return {
    id: neu.id,
    benutzername:
      (neu as { username?: string }).username ??
      eingaben.benutzername.toLowerCase(),
  };
}
