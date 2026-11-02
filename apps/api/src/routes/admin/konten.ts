import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import {
  auditLog,
  einheit,
  einheitRolle,
  teilnehmendeKonto,
  teilnehmende,
  user,
  verification,
} from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import { einheitenFuer, type Person } from "../../rechte.js";

const pfadSchema = z.strictObject({ userId: z.uuid() });
// Gespeichert wird kleingeschrieben (user_username_regel)
const sucheSchema = z.strictObject({
  benutzername: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .transform((s) => s.toLowerCase()),
});

const KONFLIKT = {
  EIGENES_KONTO: {
    code: "EIGENES_KONTO",
    message: "Das eigene Konto löscht ein anderes Admin-Konto.",
  },
  KOMMANDANT: {
    code: "KOMMANDANT",
    message:
      "Dieses Konto ist Kommandantin oder Kommandant. Zuerst das Kommando übergeben.",
  },
} as const;

type Verknuepfung = {
  einheitId: string;
  einheitName: string;
  rolle: "kommandant" | "stellvertretung" | "leitung" | "eltern" | "selbst";
};

// Alle Einheiten, in denen das Konto vorkommt: mit einer Rolle oder als Konto einer teilnehmenden Person
async function verknuepfungen(
  db: Pick<Db, "select">,
  userId: string,
): Promise<Verknuepfung[]> {
  const rollen = await db
    .select({
      einheitId: einheit.id,
      einheitName: einheit.name,
      rolle: einheitRolle.typ,
    })
    .from(einheitRolle)
    .innerJoin(einheit, eq(einheit.id, einheitRolle.einheitId))
    .where(eq(einheitRolle.userId, userId));
  const konten = await db
    .select({
      einheitId: einheit.id,
      einheitName: einheit.name,
      rolle: teilnehmendeKonto.art,
    })
    .from(teilnehmendeKonto)
    .innerJoin(
      teilnehmende,
      eq(teilnehmende.id, teilnehmendeKonto.teilnehmendeId),
    )
    .innerJoin(einheit, eq(einheit.id, teilnehmende.einheitId))
    .where(eq(teilnehmendeKonto.userId, userId));
  return [...rollen, ...konten];
}

export function erstelleKontenRouten({ db }: { db: Db }) {
  // Sichtbar ist ein Konto, wenn es in einer Einheit vorkommt, die die Person sieht (Kantonsadmin: jedes); sonst 404. Das Recht zum Löschen prüft die Route danach (403)
  async function sichtbar(
    tx: Pick<Db, "select">,
    person: Person,
    ziel: { id: string },
  ) {
    const alle = await verknuepfungen(tx, ziel.id);
    if (person.kantonsadmin) return { alle, sichtbare: alle };
    const lesen = new Set(await einheitenFuer(db, person, "lesen"));
    const sichtbare = alle.filter((v) => lesen.has(v.einheitId));
    if (sichtbare.length === 0) throw new HTTPException(404);
    return { alle, sichtbare };
  }

  return new Hono<{ Variables: { person: Person } }>()
    .get("/", eingabe("query", sucheSchema), async (c) => {
      const person = c.get("person");
      const { benutzername } = c.req.valid("query");
      const [ziel] = await db
        .select({ id: user.id, name: user.name, benutzername: user.username })
        .from(user)
        .where(eq(user.username, benutzername));
      if (!ziel) throw new HTTPException(404);
      const { sichtbare } = await sichtbar(db, person, ziel);
      if (!person.kantonsadmin) {
        const verwalten = new Set(await einheitenFuer(db, person, "verwalten"));
        if (!sichtbare.some((v) => verwalten.has(v.einheitId))) {
          throw new HTTPException(403);
        }
      }
      // Nur für die Rückfrage vor dem Löschen: wer, und wo das Konto vorkommt
      return c.json({ ...ziel, einheiten: sichtbare });
    })
    .delete("/:userId", eingabe("param", pfadSchema), async (c) => {
      const person = c.get("person");
      const { userId } = c.req.valid("param");
      const konflikt = await db.transaction(async (tx) => {
        // Sperre auf der Zeile: Eine gleichzeitige Übergabe, die die Person zur Kommandantin macht, wartet, und ihre Rolle verschwände sonst mit dem Konto
        const [ziel] = await tx
          .select({ id: user.id, role: user.role })
          .from(user)
          .where(eq(user.id, userId))
          .for("update");
        if (!ziel) throw new HTTPException(404);
        const { alle } = await sichtbar(tx, person, ziel);
        if (!person.kantonsadmin) {
          // Kein Admin-Konto und nichts in einer Einheit, die die Person nicht verwaltet; Stellvertretungen entfernt nur das Kommando
          const verwalten = new Set(
            await einheitenFuer(db, person, "verwalten"),
          );
          const nurKommando = new Set(
            await einheitenFuer(db, person, "stellvertretungen"),
          );
          if (
            ziel.role === "admin" ||
            alle.some(
              (v) =>
                !verwalten.has(v.einheitId) ||
                (v.rolle === "stellvertretung" &&
                  !nurKommando.has(v.einheitId)),
            )
          ) {
            throw new HTTPException(403);
          }
        }
        if (ziel.id === person.id) return KONFLIKT.EIGENES_KONTO;
        if (alle.some((v) => v.rolle === "kommandant"))
          return KONFLIKT.KOMMANDANT;
        // Ein Audit-Eintrag je Konto: Gehört es genau einer Einheit, steht sie dabei
        const einheiten = [...new Set(alle.map((v) => v.einheitId))];
        await tx.insert(auditLog).values({
          einheitId: einheiten.length === 1 ? einheiten[0] : null,
          akteurId: person.id,
          aktion: "konto_geloescht",
          zielTyp: "konto",
          zielId: ziel.id,
        });
        // Offene Bestätigungen des zweiten Faktors tragen die ID im Wert und haben keinen Fremdschlüssel
        await tx.delete(verification).where(eq(verification.value, ziel.id));
        // Sitzungen, Konten, zweiter Faktor, Push-Tokens, Rollen, Verknüpfungen, Anmeldungen der Leitung und Profilbild löscht CASCADE; Teilnehmende bleiben Einträge des Kommandos
        await tx.delete(user).where(eq(user.id, ziel.id));
        return null;
      });
      if (konflikt) return c.json(konflikt, 409);
      return c.body(null, 204);
    });
}
