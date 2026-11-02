import { and, eq, inArray, sql } from "drizzle-orm";
import { abzeichen, abzeichenFelder } from "./abzeichen-anzeige.js";
import { bildUrl } from "./bild.js";
import type { Db } from "./db/client.js";
import {
  einheitRolle,
  leitungAnmeldung,
  profilbild,
  rang,
  user,
} from "./db/schema.js";
import { rollenReihenfolge, type Person } from "./rechte.js";

// Der Kontakt einer Einheit, bei einem Termin (programmId) oder allgemein. Kommandant/in, solange sie oder er nicht «nein» gesagt hat; sonst die erste Stellvertretung ohne «nein»; haben alle «nein» gesagt, wieder Kommandant/in. «Offen» ist keine Absage; ein deaktiviertes Konto zählt wie «nein». Ohne programmId gibt es keine Antworten, es bleibt der Kommandant
export async function ladeKontakt(
  db: Db,
  person: Person,
  einheitId: string,
  programmId?: string,
) {
  const kandidaten = await db
    .select({
      id: user.id,
      name: user.name,
      telefon: user.telefon,
      rolle: einheitRolle.typ,
      bildUrl,
      absage: sql<boolean>`coalesce(${leitungAnmeldung.status} = 'nein' or ${user.deaktiviertAm} is not null or ${user.banned} is true, false)`,
      ...abzeichenFelder,
    })
    .from(einheitRolle)
    .innerJoin(user, eq(user.id, einheitRolle.userId))
    .leftJoin(profilbild, eq(profilbild.userId, user.id))
    .leftJoin(
      rang,
      and(eq(rang.id, einheitRolle.rangId), eq(rang.einheitId, einheitId)),
    )
    .leftJoin(
      leitungAnmeldung,
      and(
        programmId === undefined
          ? sql`false`
          : eq(leitungAnmeldung.programmId, programmId),
        eq(leitungAnmeldung.userId, einheitRolle.userId),
      ),
    )
    .where(
      and(
        eq(einheitRolle.einheitId, einheitId),
        inArray(einheitRolle.typ, ["kommandant", "stellvertretung"]),
      ),
    )
    .orderBy(rollenReihenfolge);
  const gewaehlt = kandidaten.find((k) => !k.absage) ?? kandidaten[0];
  if (!gewaehlt) return null;
  return {
    id: gewaehlt.id,
    name: gewaehlt.name,
    rolle: gewaehlt.rolle as "kommandant" | "stellvertretung",
    bildUrl: gewaehlt.bildUrl,
    abzeichen: abzeichen(gewaehlt),
    // Die Nummer sehen nur Eltern und Teilnehmende mit aktiver Person in dieser Einheit
    telefon: person.teilnehmendeEinheiten.includes(einheitId)
      ? gewaehlt.telefon
      : null,
  };
}
