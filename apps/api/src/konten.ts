import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { isAPIError } from "better-auth/api";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { erstelleAuth, platzhalterEmail } from "./auth.js";
import {
  BENUTZERNAME_MAX,
  BENUTZERNAME_MIN,
  BENUTZERNAME_MUSTER,
} from "./benutzername.js";
import type { Db } from "./db/client.js";
import * as schema from "./db/schema.js";
import {
  auditLog,
  teilnehmende,
  teilnehmendeKonto,
  user,
} from "./db/schema.js";
import { Konflikt } from "./konflikt.js";
import { aktivesKonto } from "./rechte.js";
import {
  erzeugeStartpasswort,
  normalisiereStartpasswort,
  startpasswortFelder,
} from "./startpasswort.js";
import { telefonSchema } from "./telefon.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const benutzernameFeld = z
  .string()
  .min(BENUTZERNAME_MIN)
  .max(BENUTZERNAME_MAX)
  .regex(BENUTZERNAME_MUSTER);
export const namensfeld = z.string().trim().min(1).max(100);

// Die Angaben für ein neues Konto; die Rolle ergibt sich aus der Route, nie aus dem Body
export const neuesKontoSchema = z.strictObject({
  vorname: namensfeld,
  nachname: namensfeld,
  benutzername: benutzernameFeld,
});
// Kommando und Stellvertretungen sind die Kontakte der Einheit und tragen darum eine Nummer
export const neuesKontoMitTelefonSchema = neuesKontoSchema.extend({
  telefon: telefonSchema.optional(),
});

export interface NeuesKonto {
  vorname: string;
  nachname: string;
  benutzername: string;
  telefon?: string | null;
}

export interface AngelegtesKonto {
  id: string;
  benutzername: string;
  startpasswort: string;
}

// Legt Konten in der Transaktion des Aufrufers an; ein Fehler (auch HIBP) nimmt alles zurück. createUser legt den User vor der HIBP-Prüfung an, darum nie ausserhalb einer Transaktion. Ohne Header prüft createUser keine Rechte: Die Route hat sie vorher geprüft
export function erstelleKontoFabrik(tx: Tx) {
  const txAuth = erstelleAuth(
    drizzleAdapter(tx, { provider: "pg", schema, transaction: true }),
  );
  return async (konto: NeuesKonto): Promise<AngelegtesKonto> => {
    const startpasswort = erzeugeStartpasswort();
    try {
      const { user: neu } = await txAuth.api.createUser({
        body: {
          email: platzhalterEmail(),
          password: normalisiereStartpasswort(startpasswort),
          name: `${konto.vorname} ${konto.nachname}`,
          role: "user",
          data: {
            username: konto.benutzername,
            ...startpasswortFelder(new Date(), startpasswort),
            ...(konto.telefon && { telefon: konto.telefon }),
          },
        },
      });
      return {
        id: neu.id,
        // Das Plugin speichert kleingeschrieben; sein Typ kennt das Feld nicht
        benutzername:
          (neu as { username?: string }).username ??
          konto.benutzername.toLowerCase(),
        startpasswort,
      };
    } catch (fehler) {
      if (
        isAPIError(fehler) &&
        fehler.body?.code === "USERNAME_IS_ALREADY_TAKEN"
      ) {
        throw new Konflikt("BENUTZERNAME_VERGEBEN");
      }
      throw fehler;
    }
  };
}

// Im selben Commit wie die Aktion; details ohne Personendaten (IDs, Rollen, Zahlen)
export function protokolliere(
  tx: Pick<Db, "insert">,
  {
    einheitId,
    akteurId,
    aktion,
    zielTyp,
    zielId,
    details,
  }: {
    einheitId: string | null;
    akteurId: string;
    aktion: string;
    zielTyp: "person" | "teilnehmende" | "bezirk" | "einheit";
    zielId: string;
    details?: Record<string, unknown>;
  },
) {
  return tx
    .insert(auditLog)
    .values({ einheitId, akteurId, aktion, zielTyp, zielId, details });
}

// Pro Teilnehmende/r antworten entweder die Eltern oder die Person selbst, nie beide. Die Zeilensperre auf der Person lässt zwei gleichzeitige Verknüpfungen nacheinander laufen; die Datenbank sichert nur höchstens ein eigenes Konto
export async function verknuepfeKonto(
  tx: Tx,
  {
    teilnehmendeId,
    userId,
    art,
  }: { teilnehmendeId: string; userId: string; art: "eltern" | "selbst" },
) {
  await tx
    .select({ id: teilnehmende.id })
    .from(teilnehmende)
    .where(eq(teilnehmende.id, teilnehmendeId))
    .for("no key update");
  const vorhandene = await tx
    .select({
      userId: teilnehmendeKonto.userId,
      art: teilnehmendeKonto.art,
    })
    .from(teilnehmendeKonto)
    .where(eq(teilnehmendeKonto.teilnehmendeId, teilnehmendeId));
  if (vorhandene.some((v) => v.userId === userId)) {
    throw new Konflikt("SCHON_VERKNUEPFT");
  }
  if (art === "eltern" && vorhandene.some((v) => v.art === "selbst")) {
    throw new Konflikt("SELBST_ANTWORTET");
  }
  if (art === "selbst" && vorhandene.some((v) => v.art === "selbst")) {
    throw new Konflikt("EIGENES_KONTO_VORHANDEN");
  }
  if (art === "selbst" && vorhandene.length > 0) {
    throw new Konflikt("ELTERN_ANTWORTEN");
  }
  await tx.insert(teilnehmendeKonto).values({ userId, teilnehmendeId, art });
}

// Ein bestehendes Konto als Elternteil: aktiv, kein Konto des Kantonsadmins und keines, das selbst für eine Person antwortet. Gibt die ID zurück, sonst undefined
export async function findeElternKonto(tx: Tx, benutzername: string) {
  const [konto] = await tx
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(and(eq(user.username, benutzername.toLowerCase()), aktivesKonto()));
  if (!konto || konto.role === "admin") return undefined;
  const [selbst] = await tx
    .select({ userId: teilnehmendeKonto.userId })
    .from(teilnehmendeKonto)
    .where(
      and(
        eq(teilnehmendeKonto.userId, konto.id),
        eq(teilnehmendeKonto.art, "selbst"),
      ),
    )
    .limit(1);
  return selbst ? undefined : konto.id;
}

// Sperre für Vorgänge, die Bestand lesen und danach schreiben: Zwei gleichzeitige laufen nacheinander
export async function sperreEinheit(tx: Tx, schluessel: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${schluessel}))`);
}
