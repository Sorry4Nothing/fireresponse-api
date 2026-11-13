import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { einheitRolle, leitungAnmeldung, programm, user } from "./db/schema.js";
import { aktivesKonto } from "./rechte.js";

// Eine Abfrage oder eine Transaktion
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Abfrage = Db | Tx;

export type LeitungPlaetze = {
  hoechstzahl: number;
  belegt: number;
  frei: number;
  voll: boolean;
  wartende: number;
  eigenePosition: number | null;
};

// Zusagen und Wartende zählen nur, solange die Person eine Rolle in der Einheit hat und ihr Konto aktiv ist
const aktive = (q: Abfrage, programmId: string, einheitId: string) =>
  q
    .select({
      userId: leitungAnmeldung.userId,
      status: leitungAnmeldung.status,
    })
    .from(leitungAnmeldung)
    .innerJoin(
      einheitRolle,
      and(
        eq(einheitRolle.userId, leitungAnmeldung.userId),
        eq(einheitRolle.einheitId, einheitId),
      ),
    )
    .innerJoin(user, and(eq(user.id, leitungAnmeldung.userId), aktivesKonto()))
    .where(eq(leitungAnmeldung.programmId, programmId));

export async function zaehleZusagen(
  q: Abfrage,
  programmId: string,
  einheitId: string,
) {
  const zeilen = await aktive(q, programmId, einheitId);
  return zeilen.filter((z) => z.status === "ja").length;
}

// Wartende in der Reihenfolge ihrer Eintragung; bei gleichem Zeitpunkt entscheidet die ID
export async function wartende(
  q: Abfrage,
  programmId: string,
  einheitId: string,
) {
  const zeilen = await aktive(q, programmId, einheitId)
    .orderBy(asc(leitungAnmeldung.wartelisteSeit), asc(leitungAnmeldung.userId))
    .then((z) => z.filter((e) => e.status === "warteliste"));
  return zeilen.map((z) => z.userId);
}

// Rückt Wartende der Reihe nach in freie Plätze; ohne Höchstzahl alle. Nur in einer Transaktion, die die Zeile des Programms gesperrt hat. Gibt die Nachgerückten zurück (für den Push nach dem Commit)
export async function rueckeNach(
  tx: Tx,
  programmId: string,
  einheitId: string,
  hoechstzahl: number | null,
): Promise<string[]> {
  const frei =
    hoechstzahl === null
      ? Infinity
      : hoechstzahl - (await zaehleZusagen(tx, programmId, einheitId));
  if (frei <= 0) return [];
  const ids = (await wartende(tx, programmId, einheitId)).slice(0, frei);
  if (ids.length === 0) return [];
  await tx
    .update(leitungAnmeldung)
    .set({ status: "ja", wartelisteSeit: null })
    .where(
      and(
        eq(leitungAnmeldung.programmId, programmId),
        inArray(leitungAnmeldung.userId, ids),
      ),
    );
  return ids;
}

const schreibe = (
  tx: Tx,
  programmId: string,
  userId: string,
  status: "ja" | "nein" | "warteliste",
) =>
  tx
    .insert(leitungAnmeldung)
    .values({
      programmId,
      userId,
      status,
      // clock_timestamp statt now(): now() ist der Beginn der Transaktion, der Zeitpunkt der Eintragung liegt aber nach der Sperre
      wartelisteSeit: status === "warteliste" ? sql`clock_timestamp()` : null,
    })
    .onConflictDoUpdate({
      target: [leitungAnmeldung.programmId, leitungAnmeldung.userId],
      set: {
        status,
        // Wer schon wartet, behält den Platz in der Reihe
        wartelisteSeit:
          status === "warteliste"
            ? sql`coalesce(${leitungAnmeldung.wartelisteSeit}, clock_timestamp())`
            : null,
      },
    });

// Zusage oder Absage von Kommando oder Leitung. Die Zeile des Programms ist für die ganze Transaktion gesperrt: Prüfen, Eintragen und Nachrücken sind unteilbar, auch bei zwei gleichzeitigen Zusagen um den letzten Platz. undefined: Das Programm gibt es nicht mehr
export async function setzeLeitung(
  db: Db,
  {
    programmId,
    userId,
    status,
  }: { programmId: string; userId: string; status: "ja" | "nein" },
) {
  return db.transaction(async (tx) => {
    // no key update: sperrt andere Änderungen am Programm, nicht aber das Eintragen von Anmeldungen mit Fremdschlüssel
    const [p] = await tx
      .select({
        einheitId: programm.einheitId,
        hoechstzahl: programm.leitungHoechstzahl,
      })
      .from(programm)
      .where(eq(programm.id, programmId))
      .for("no key update");
    if (!p) return undefined;
    let nachgerueckt: string[];
    let ergebnis: "ja" | "nein" | "warteliste";
    if (status === "nein") {
      await schreibe(tx, programmId, userId, "nein");
      nachgerueckt = await rueckeNach(
        tx,
        programmId,
        p.einheitId,
        p.hoechstzahl,
      );
      ergebnis = "nein";
    } else {
      // Frei gewordene Plätze zuerst an die Wartenden (z. B. nach dem Entfernen einer Rolle), dann erst die neue Zusage prüfen
      nachgerueckt = await rueckeNach(
        tx,
        programmId,
        p.einheitId,
        p.hoechstzahl,
      );
      const [eigen] = await tx
        .select({ status: leitungAnmeldung.status })
        .from(leitungAnmeldung)
        .where(
          and(
            eq(leitungAnmeldung.programmId, programmId),
            eq(leitungAnmeldung.userId, userId),
          ),
        );
      if (eigen?.status === "ja") {
        ergebnis = "ja";
      } else {
        const belegt =
          p.hoechstzahl === null
            ? 0
            : await zaehleZusagen(tx, programmId, p.einheitId);
        ergebnis =
          p.hoechstzahl === null || belegt < p.hoechstzahl
            ? "ja"
            : "warteliste";
        await schreibe(tx, programmId, userId, ergebnis);
      }
    }
    const position =
      ergebnis === "warteliste"
        ? (await wartende(tx, programmId, p.einheitId)).indexOf(userId) + 1
        : null;
    return {
      status: ergebnis,
      position,
      // Wer selbst zusagt, braucht keinen Push «nachgerückt»
      nachgerueckt: nachgerueckt.filter((id) => id !== userId),
    };
  });
}

type Plaetze = LeitungPlaetze & { begonnen: boolean };

// Fremdschlüssel gleich überall: aktive Mitglieder der Einheit des Programms mit dem Status
const mitStatus = (status: "ja" | "warteliste") => sql`
  from ${leitungAnmeldung}
  join ${einheitRolle} on ${einheitRolle.userId} = ${leitungAnmeldung.userId} and ${einheitRolle.einheitId} = ${programm.einheitId}
  join ${user} on ${user.id} = ${leitungAnmeldung.userId} and ${aktivesKonto()}
  where ${leitungAnmeldung.programmId} = ${programm.id} and ${leitungAnmeldung.status} = ${status}`;

// Die Plätze der Termine mit Höchstzahl, ein Eintrag je Termin; Termine ohne Höchstzahl fehlen. Ist der Termin begonnen, ist die Warteliste verfallen: wartende 0, keine eigene Position
export async function ladePlaetze(
  db: Db,
  programmIds: string[],
  userId: string,
): Promise<Map<string, Plaetze>> {
  const karte = new Map<string, Plaetze>();
  if (programmIds.length === 0) return karte;
  const zeilen = await db.execute<{
    id: string;
    hoechstzahl: number;
    begonnen: boolean;
    belegt: number;
    wartende: number;
    position: number | null;
  }>(sql`
    select ${programm.id} as "id", ${programm.leitungHoechstzahl} as "hoechstzahl",
      (coalesce(programm.beginn, programm.tag_von::timestamp at time zone 'Europe/Zurich') <= now()) as "begonnen",
      (select count(*)::int ${mitStatus("ja")}) as "belegt",
      (select count(*)::int ${mitStatus("warteliste")}) as "wartende",
      (select w."pos" from (
        select ${leitungAnmeldung.userId} as "uid", row_number() over (order by ${leitungAnmeldung.wartelisteSeit}, ${leitungAnmeldung.userId})::int as "pos"
        ${mitStatus("warteliste")}
      ) w where w."uid" = ${userId}) as "position"
    from ${programm}
    where ${inArray(programm.id, programmIds)} and ${programm.leitungHoechstzahl} is not null`);
  for (const z of zeilen) {
    const wartet = !z.begonnen;
    const frei = Math.max(z.hoechstzahl - z.belegt, 0);
    karte.set(z.id, {
      hoechstzahl: z.hoechstzahl,
      belegt: z.belegt,
      frei,
      voll: frei === 0,
      wartende: wartet ? z.wartende : 0,
      eigenePosition: wartet ? z.position : null,
      begonnen: z.begonnen,
    });
  }
  return karte;
}

// Ohne die interne Angabe «begonnen» für die Antwort
export const ohneBegonnen = (p: Plaetze): LeitungPlaetze => ({
  hoechstzahl: p.hoechstzahl,
  belegt: p.belegt,
  frei: p.frei,
  voll: p.voll,
  wartende: p.wartende,
  eigenePosition: p.eigenePosition,
});

// «warteliste» gilt nur bis zum Beginn des Termins; danach ist die Person wieder ohne Platz und ohne Antwort
export const eigeneAnmeldungWert = <T extends string>(
  status: T,
  plaetze: Plaetze | undefined,
) => (status === "warteliste" && plaetze?.begonnen ? "offen" : status);
