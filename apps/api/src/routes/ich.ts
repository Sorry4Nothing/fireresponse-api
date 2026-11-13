import { and, asc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../db/client.js";
import {
  bezirk,
  einheit,
  einheitRolle,
  profilbild,
  rang,
  teilnehmende,
  teilnehmendeKonto,
  user,
} from "../db/schema.js";
import { abzeichenFelder, mitAbzeichen } from "../abzeichen-anzeige.js";
import { bildUrl } from "../bild.js";
import { logoUrl } from "../einheiten.js";
import { eingabe } from "../eingabe.js";
import type { Person } from "../rechte.js";
import { telefonSchema } from "../telefon.js";

// Mindestens ein Feld: Ein leeres set() wirft in Drizzle («No values to set»)
const profilSchema = z
  .strictObject({
    pushProgramme: z.boolean(),
    pushAnmeldungen: z.boolean(),
    pushInfokanal: z.boolean(),
    telefon: telefonSchema,
  })
  .partial()
  .refine((b) => Object.values(b).some((wert) => wert !== undefined));

// Auch in den Importen ohne node:* und process: Die App prüft diese Datei über AppType
export function erstelleIchRouten({ db }: { db: Db }) {
  return (
    new Hono<{ Variables: { person: Person } }>()
      .get("/", async (c) => {
        const person = c.get("person");
        // Nie email, Bremsfelder, banned, startpasswortGueltigBis oder Geheimnisse und Codes des zweiten Faktors: Die App braucht sie nicht
        const [profil] = await db
          .select({
            id: user.id,
            name: user.name,
            benutzername: user.username,
            mussPasswortAendern: user.mussPasswortAendern,
            telefon: user.telefon,
            pushProgramme: user.pushProgramme,
            pushAnmeldungen: user.pushAnmeldungen,
            pushInfokanal: user.pushInfokanal,
            bildUrl,
          })
          .from(user)
          .leftJoin(profilbild, eq(profilbild.userId, user.id))
          .where(eq(user.id, person.id));
        // Die Sitzung löscht die Datenbank mit der Person (CASCADE); ohne Zeile ist sie nicht mehr gültig
        if (!profil) throw new HTTPException(401);
        const einheiten = await db
          .select({
            id: einheit.id,
            name: einheit.name,
            typ: einheit.typ,
            bezirk: bezirk.name,
            rolle: einheitRolle.typ,
            logoUrl,
            ...abzeichenFelder,
          })
          .from(einheitRolle)
          .innerJoin(einheit, eq(einheit.id, einheitRolle.einheitId))
          .innerJoin(bezirk, eq(bezirk.id, einheit.bezirkId))
          .leftJoin(
            rang,
            and(
              eq(rang.id, einheitRolle.rangId),
              eq(rang.einheitId, einheitRolle.einheitId),
            ),
          )
          .where(eq(einheitRolle.userId, person.id))
          .orderBy(asc(bezirk.name), asc(einheit.typ));
        const teilnehmendeListe = await db
          .select({
            id: teilnehmende.id,
            vorname: teilnehmende.vorname,
            nachname: teilnehmende.nachname,
            einheitId: teilnehmende.einheitId,
            // Name und Typ der Einheit des eigenen Kindes: Die Liste einheiten oben kennt nur Einheiten mit Rolle
            einheitName: einheit.name,
            einheitTyp: einheit.typ,
            art: teilnehmendeKonto.art,
            ...abzeichenFelder,
          })
          .from(teilnehmendeKonto)
          .innerJoin(
            teilnehmende,
            eq(teilnehmende.id, teilnehmendeKonto.teilnehmendeId),
          )
          .innerJoin(einheit, eq(einheit.id, teilnehmende.einheitId))
          .leftJoin(
            rang,
            and(
              eq(rang.id, teilnehmende.rangId),
              eq(rang.einheitId, teilnehmende.einheitId),
            ),
          )
          .where(
            and(
              eq(teilnehmendeKonto.userId, person.id),
              isNull(teilnehmende.inaktivSeit),
            ),
          )
          .orderBy(asc(teilnehmende.vorname), asc(teilnehmende.id));
        // Der Anmelde-Push gilt nur dem Kommando und den Leitenden: Allen anderen zeigt die API den Schalter nicht
        const { pushAnmeldungen, ...rest } = profil;
        return c.json({
          ...rest,
          ...(person.einheiten.length > 0 && { pushAnmeldungen }),
          kantonsadmin: person.kantonsadmin,
          zweiterFaktor: person.zweiterFaktor,
          einwilligung: person.einwilligung,
          einheiten: einheiten.map(mitAbzeichen),
          teilnehmende: teilnehmendeListe.map(mitAbzeichen),
        });
      })
      // Nur die eigenen Schalter und die eigene Nummer; die Person kommt aus der Sitzung, nie aus dem Body
      .patch("/", eingabe("json", profilSchema), async (c) => {
        const person = c.get("person");
        const daten = c.req.valid("json");
        // Eine Nummer speichern nur Kommando und Stellvertretungen (sie sind die Kontakte); entfernen darf jede Person, auch eine, die die Rolle verloren hat
        if (
          daten.telefon &&
          !person.einheiten.some(
            (r) => r.typ === "kommandant" || r.typ === "stellvertretung",
          )
        ) {
          throw new HTTPException(403);
        }
        await db.update(user).set(daten).where(eq(user.id, person.id));
        return c.body(null, 204);
      })
  );
}
