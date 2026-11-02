import { eq, inArray } from "drizzle-orm";
import type { Db } from "./db/client.js";
import {
  einheitRolle,
  teilnehmende,
  teilnehmendeKonto,
  user,
} from "./db/schema.js";
import type { Person, RollenTyp } from "./rechte.js";

export interface KontoZiel {
  id: string;
  name: string;
  // Die Rolle in genau dieser Einheit; Eltern und Teilnehmende haben keine
  rolleHier: RollenTyp | null;
  // Das Konto gehört auch zu einer anderen Einheit (Rolle oder Verknüpfung)
  gemeinsam: boolean;
}

// Ein Konto gehört zur Einheit, wenn es dort eine Rolle hat oder für eine ihrer Personen antwortet; sonst undefined (404)
export async function ladeKontoZiel(
  tx: Pick<Db, "select">,
  einheitId: string,
  userId: string,
): Promise<KontoZiel | undefined> {
  const [konto] = await tx
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(eq(user.id, userId));
  if (!konto) return undefined;
  const rollen = await tx
    .select({ einheitId: einheitRolle.einheitId, typ: einheitRolle.typ })
    .from(einheitRolle)
    .where(eq(einheitRolle.userId, userId));
  const verknuepft = await tx
    .select({ einheitId: teilnehmende.einheitId })
    .from(teilnehmendeKonto)
    .innerJoin(
      teilnehmende,
      eq(teilnehmende.id, teilnehmendeKonto.teilnehmendeId),
    )
    .where(eq(teilnehmendeKonto.userId, userId));
  const einheiten = [...rollen, ...verknuepft].map((z) => z.einheitId);
  if (!einheiten.includes(einheitId)) return undefined;
  return {
    id: konto.id,
    name: konto.name,
    rolleHier: rollen.find((r) => r.einheitId === einheitId)?.typ ?? null,
    gemeinsam: einheiten.some((id) => id !== einheitId),
  };
}

// Welche dieser Konten gehören auch zu einer anderen Einheit? Für die Listen; ladeKontoZiel beantwortet es für ein Konto
export async function gemeinsameKonten(
  tx: Pick<Db, "select">,
  einheitId: string,
  userIds: string[],
) {
  if (userIds.length === 0) return new Set<string>();
  const rollen = await tx
    .select({ userId: einheitRolle.userId, einheitId: einheitRolle.einheitId })
    .from(einheitRolle)
    .where(inArray(einheitRolle.userId, userIds));
  const verknuepft = await tx
    .select({
      userId: teilnehmendeKonto.userId,
      einheitId: teilnehmende.einheitId,
    })
    .from(teilnehmendeKonto)
    .innerJoin(
      teilnehmende,
      eq(teilnehmende.id, teilnehmendeKonto.teilnehmendeId),
    )
    .where(inArray(teilnehmendeKonto.userId, userIds));
  return new Set(
    [...rollen, ...verknuepft]
      .filter((z) => z.einheitId !== einheitId)
      .map((z) => z.userId),
  );
}

export interface KontoAktionen {
  // Name und Telefon
  bearbeiten: boolean;
  startpasswort: boolean;
  deaktivieren: boolean;
  zweiterFaktor: boolean;
}

// Eine Stelle für «wer darf was am Konto»: Die Routen prüfen damit, die Listen zeigen damit nur die erlaubten Knöpfe. Der Kantonsadmin darf alles ausser am eigenen Konto. Kommando und Stellvertretung ändern nur Konten, die ganz in ihrer Einheit liegen (sonst läse das Kommando über ein neues Passwort die Kinder einer fremden Einheit), das Kommando nur der Kantonsadmin und eine Stellvertretung nur das Kommando oder der Kantonsadmin
export function erlaubteAktionen(
  akteur: Person,
  einheitId: string,
  ziel: KontoZiel,
): KontoAktionen {
  const keine = {
    bearbeiten: false,
    startpasswort: false,
    deaktivieren: false,
    zweiterFaktor: false,
  };
  if (ziel.id === akteur.id) return keine;
  if (!akteur.kantonsadmin) {
    if (ziel.gemeinsam) return keine;
    const eigene = akteur.einheiten.find((r) => r.einheitId === einheitId)?.typ;
    if (ziel.rolleHier === "kommandant") return keine;
    if (ziel.rolleHier === "stellvertretung" && eigene !== "kommandant") {
      return keine;
    }
  }
  return {
    bearbeiten: true,
    startpasswort: true,
    deaktivieren: true,
    zweiterFaktor: true,
  };
}

// Zustand für die Liste: nie das Passwort, nur ob eines offen ist und bis wann
export function kontoZustand(
  u: {
    twoFactorEnabled: boolean | null;
    mussPasswortAendern: boolean;
    startpasswortGueltigBis: Date | null;
    banned: boolean | null;
    deaktiviertAm: Date | null;
  },
  jetzt = new Date(),
) {
  return {
    zweiterFaktor: u.twoFactorEnabled === true,
    startpasswort: u.mussPasswortAendern
      ? {
          gueltigBis: u.startpasswortGueltigBis,
          // Ohne Datum gilt wie bei der Anmeldung: abgelaufen
          abgelaufen: !(
            u.startpasswortGueltigBis && u.startpasswortGueltigBis > jetzt
          ),
        }
      : null,
    deaktiviert: u.banned === true || u.deaktiviertAm !== null,
  };
}
