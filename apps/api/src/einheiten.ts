import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { auditLog, einheit, einheitRolle, rang } from "./db/schema.js";
import { MILIZ_ABZEICHEN } from "./milizAbzeichen.js";

type Tx = Pick<Db, "select" | "insert" | "update" | "delete">;

// Vier Standard-Ränge wie im Design: ohne Abzeichen, ohne Stern, 1 Stern, 2 Sterne; danach frei änderbar. Die Migration 0005 stellt bestehende Einheiten gleich um
export const STANDARD_RAENGE = [null, 0, 1, 2].map((sterne, n) => ({
  name: `Rang ${n}`,
  kuerzel: `R${n}`,
  reihenfolge: (n + 1) * 10,
  abzeichenSterne: sterne,
}));

// Dienstgrade der Feuerwehr in der Schweiz in der Reihenfolge und Schreibweise der Quelle (Wikipedia, «Dienstgrade der Feuerwehr in der Schweiz»). Jede Einheit hat sie als Ränge vom Typ miliz, denn Leitende tragen sie; die Reihenfolge zählt je Typ, die Miliz-Ränge beginnen also bei 10. Die Migration 0008 legt sie für bestehende Einheiten an; ändert sich die Liste, ändert sich die Migration nicht mit
export const MILIZ_RAENGE = [
  ["Oberst", "Oberst"],
  ["Oberstleutnant", "Oberstlt"],
  ["Major", "Maj"],
  ["Hauptmann", "Hptm"],
  ["Oberleutnant", "Oblt"],
  ["Leutnant", "Lt"],
  ["Adjutant Unteroffizier", "Adj Uof"],
  ["Feldweibel", "Fw"],
  ["Fourier", "Four"],
  ["Wachtmeister", "Wm"],
  ["Korporal", "Kpl"],
  ["Gefreiter", "Gfr"],
  ["Soldat", "Sdt"],
  ["Rekrut", "Rekr"],
].map(([name, kuerzel], n) => ({
  name,
  kuerzel,
  typ: "miliz" as const,
  reihenfolge: (n + 1) * 10,
  abzeichenSterne: null,
  abzeichenBild: new TextEncoder().encode(MILIZ_ABZEICHEN[name]),
  abzeichenBildTyp: "svg" as const,
}));

// Adresse des Logos oder null; ?v= ändert sich mit dem Bild, damit die App ihren Speicher danach richten kann
export const logoUrl = sql<
  string | null
>`case when ${einheit.logoBild} is null then null else '/api/v1/einheiten/' || ${einheit.id} || '/logo?v=' || left(md5(${einheit.logoBild}), 8) end`;

// Wie logoUrl, aber die Adresse der Verwaltung: Sie fragt die Einwilligung der App nicht ab
export const adminLogoUrl = sql<
  string | null
>`case when ${einheit.logoBild} is null then null else '/api/v1/admin/einheiten/' || ${einheit.id} || '/logo?v=' || left(md5(${einheit.logoBild}), 8) end`;

// Eine Einheit entsteht nur zusammen mit ihrer Kommandantin oder ihrem Kommandanten. Aufrufen in einer Transaktion
export async function legeEinheitAn(
  tx: Tx,
  {
    bezirkId,
    typ,
    name,
    kommandantId,
    akteurId,
  }: {
    bezirkId: string;
    typ: "jf" | "kf";
    name: string;
    kommandantId: string;
    akteurId: string;
  },
) {
  const [neu] = await tx
    .insert(einheit)
    .values({ bezirkId, typ, name })
    .returning({ id: einheit.id });
  await tx
    .insert(rang)
    .values(
      [...STANDARD_RAENGE.map((r) => ({ ...r, typ })), ...MILIZ_RAENGE].map(
        (r) => ({ ...r, einheitId: neu.id }),
      ),
    );
  await tx
    .insert(einheitRolle)
    .values({ userId: kommandantId, einheitId: neu.id, typ: "kommandant" });
  await tx.insert(auditLog).values({
    einheitId: neu.id,
    akteurId,
    aktion: "einheit_angelegt",
    zielTyp: "einheit",
    zielId: neu.id,
  });
  return neu.id;
}

// Neue Rolle der bisherigen Kommandantin oder des bisherigen Kommandanten
export type BisherigeRolle =
  | { typ: "stellvertretung"; reihenfolge: number }
  | { typ: "leitung" }
  | { typ: "keine" };

export class UebergabeFehler extends Error {
  constructor(public code: "KEIN_KOMMANDANT" | "GLEICHE_PERSON") {
    super(code);
  }
}

// Tauscht die Rolle in einer Transaktion: Die Einheit ist nie ohne Kommandant/in und nie mit zwei. Die Reihenfolge der Stellvertretungen bleibt; eine neue Position schiebt die übrigen nach hinten
export async function uebergibKommando(
  tx: Tx,
  {
    einheitId,
    neuerKommandantId,
    bisherige,
    akteurId,
  }: {
    einheitId: string;
    neuerKommandantId: string;
    bisherige: BisherigeRolle;
    akteurId: string;
  },
) {
  // Zeilensperre auf der Einheit: Zwei gleichzeitige Übergaben laufen nacheinander
  await tx
    .select({ id: einheit.id })
    .from(einheit)
    .where(eq(einheit.id, einheitId))
    .for("no key update");
  const [bisher] = await tx
    .select({ userId: einheitRolle.userId, rangId: einheitRolle.rangId })
    .from(einheitRolle)
    .where(
      and(
        eq(einheitRolle.einheitId, einheitId),
        eq(einheitRolle.typ, "kommandant"),
      ),
    );
  if (!bisher) throw new UebergabeFehler("KEIN_KOMMANDANT");
  if (bisher.userId === neuerKommandantId) {
    throw new UebergabeFehler("GLEICHE_PERSON");
  }
  // Erst die bisherige Person aus der Kommandantenrolle nehmen (partieller UNIQUE-Index), dann die neue einsetzen
  await tx
    .delete(einheitRolle)
    .where(
      and(
        eq(einheitRolle.einheitId, einheitId),
        eq(einheitRolle.userId, bisher.userId),
      ),
    );
  // Die neue Person verlässt ihre bisherige Rolle in dieser Einheit (ihren Rang nimmt sie mit); eine frei werdende Position der Stellvertretung bleibt leer
  const [vorher] = await tx
    .delete(einheitRolle)
    .where(
      and(
        eq(einheitRolle.einheitId, einheitId),
        eq(einheitRolle.userId, neuerKommandantId),
      ),
    )
    .returning({ rangId: einheitRolle.rangId });
  await tx.insert(einheitRolle).values({
    userId: neuerKommandantId,
    einheitId,
    typ: "kommandant",
    rangId: vorher?.rangId ?? null,
  });
  if (bisherige.typ === "stellvertretung") {
    // Die Position frei machen: Alle ab dort rücken um eins nach hinten, von hinten nach vorn, weil der UNIQUE-Index nicht aufgeschoben ist
    const betroffene = await tx
      .select({
        userId: einheitRolle.userId,
        reihenfolge: einheitRolle.reihenfolge,
      })
      .from(einheitRolle)
      .where(
        and(
          eq(einheitRolle.einheitId, einheitId),
          eq(einheitRolle.typ, "stellvertretung"),
          gte(einheitRolle.reihenfolge, bisherige.reihenfolge),
        ),
      )
      .orderBy(desc(einheitRolle.reihenfolge));
    for (const b of betroffene) {
      await tx
        .update(einheitRolle)
        .set({ reihenfolge: sql`${einheitRolle.reihenfolge} + 1` })
        .where(
          and(
            eq(einheitRolle.einheitId, einheitId),
            eq(einheitRolle.userId, b.userId),
          ),
        );
    }
    await tx.insert(einheitRolle).values({
      userId: bisher.userId,
      einheitId,
      typ: "stellvertretung",
      reihenfolge: bisherige.reihenfolge,
      rangId: bisher.rangId,
    });
  } else if (bisherige.typ === "leitung") {
    await tx.insert(einheitRolle).values({
      userId: bisher.userId,
      einheitId,
      typ: "leitung",
      rangId: bisher.rangId,
    });
  }
  await tx.insert(auditLog).values({
    einheitId,
    akteurId,
    aktion: "kommando_uebergeben",
    zielTyp: "einheit",
    zielId: einheitId,
    details: { bisherigeRolle: bisherige.typ },
  });
}
