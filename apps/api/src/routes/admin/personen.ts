import { hashPassword } from "better-auth/crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import {
  account,
  profilbild,
  rang,
  session,
  teilnehmendeKonto,
  user,
  einheitRolle,
} from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import { Konflikt } from "../../konflikt.js";
import {
  erlaubteAktionen,
  gemeinsameKonten,
  kontoZustand,
  ladeKontoZiel,
  type KontoAktionen,
  type KontoZiel,
} from "../../konto-verwaltung.js";
import { protokolliere } from "../../konten.js";
import { pruefeEinheit, rollenReihenfolge, type Person } from "../../rechte.js";
import {
  entschluesseleStartpasswort,
  erzeugeStartpasswort,
  normalisiereStartpasswort,
  startpasswortFelder,
} from "../../startpasswort.js";
import { telefonSchema } from "../../telefon.js";
import { setzeZweitenFaktorZurueck } from "../../zweiter-faktor.js";
import {
  sperreStellvertretungen,
  stellvertretungen,
} from "./stellvertretungen.js";

const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const zielPfad = z.strictObject({ einheitId: z.uuid(), userId: z.uuid() });
// «Vorname Nachname» in einem Feld, wie user.name beim Anlegen
const aendernSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(201),
    telefon: telefonSchema,
    rangId: z.uuid().nullable(),
  })
  .partial()
  .refine((b) => Object.values(b).some((wert) => wert !== undefined));

const rolleSchema = z.strictObject({
  rolle: z.enum(["leitung", "stellvertretung"]),
});

// Darf der Akteur diese Aktion am Konto? Sonst die Antwort, die dem Panel den Grund nennt
function pruefeAktion(
  person: Person,
  einheitId: string,
  ziel: KontoZiel,
  aktion: keyof KontoAktionen,
) {
  if (erlaubteAktionen(person, einheitId, ziel)[aktion]) return;
  if (ziel.id === person.id) throw new Konflikt("EIGENES_KONTO");
  if (ziel.gemeinsam && !person.kantonsadmin) {
    throw new Konflikt("KONTO_GEMEINSAM");
  }
  throw new HTTPException(403);
}

// Konten der Einheit: die Liste zeigt Kommando, Stellvertretungen und Leitende, die Aktionen gelten für jedes Konto, das in der Einheit eine Rolle hat oder für eine ihrer Personen antwortet. Nie ein Passwort in einer Liste: das Startpasswort liefert nur sein eigener Abruf
export function erstellePersonenRouten({ db }: { db: Db }) {
  // Fremde wie unbekannte Einheiten sind 404, danach Konten ausserhalb der Einheit; erst dann zählt das Recht
  async function ladeZiel(person: Person, einheitId: string, userId: string) {
    await pruefeEinheit(db, person, einheitId, "verwalten");
    const ziel = await ladeKontoZiel(db, einheitId, userId);
    if (!ziel) throw new HTTPException(404);
    return ziel;
  }

  return new Hono<{ Variables: { person: Person } }>()
    .get("/", eingabe("param", einheitPfad), async (c) => {
      const person = c.get("person");
      const { einheitId } = c.req.valid("param");
      await pruefeEinheit(db, person, einheitId, "verwalten");
      const zeilen = await db
        .select({
          id: user.id,
          name: user.name,
          benutzername: user.username,
          telefon: user.telefon,
          rolle: einheitRolle.typ,
          reihenfolge: einheitRolle.reihenfolge,
          rangId: rang.id,
          rangName: rang.name,
          twoFactorEnabled: user.twoFactorEnabled,
          mussPasswortAendern: user.mussPasswortAendern,
          startpasswortGueltigBis: user.startpasswortGueltigBis,
          banned: user.banned,
          deaktiviertAm: user.deaktiviertAm,
        })
        .from(einheitRolle)
        .innerJoin(user, eq(user.id, einheitRolle.userId))
        .leftJoin(rang, eq(rang.id, einheitRolle.rangId))
        .where(eq(einheitRolle.einheitId, einheitId))
        .orderBy(rollenReihenfolge, asc(user.name), asc(user.id));
      const gemeinsam = await gemeinsameKonten(
        db,
        einheitId,
        zeilen.map((z) => z.id),
      );
      // Nie email, Bremsfelder, banReason oder Geheimnisse und Codes des zweiten Faktors
      return c.json({
        personen: zeilen.map((z) => ({
          id: z.id,
          name: z.name,
          benutzername: z.benutzername,
          telefon: z.telefon,
          rolle: z.rolle,
          reihenfolge: z.reihenfolge,
          rang: z.rangId ? { id: z.rangId, name: z.rangName } : null,
          eigenes: z.id === person.id,
          gemeinsam: gemeinsam.has(z.id),
          ...kontoZustand(z),
          aktionen: erlaubteAktionen(person, einheitId, {
            id: z.id,
            name: z.name,
            rolleHier: z.rolle,
            gemeinsam: gemeinsam.has(z.id),
          }),
        })),
      });
    })
    .patch(
      "/:userId",
      eingabe("param", zielPfad),
      eingabe("json", aendernSchema),
      async (c) => {
        const person = c.get("person");
        const { einheitId, userId } = c.req.valid("param");
        const aenderung = c.req.valid("json");
        const ziel = await ladeZiel(person, einheitId, userId);
        if (aenderung.name !== undefined || aenderung.telefon !== undefined) {
          pruefeAktion(person, einheitId, ziel, "bearbeiten");
        }
        // Eine Nummer speichern nur Kommando und Stellvertretungen (die Kontakte); entfernen geht immer
        if (
          aenderung.telefon &&
          ziel.rolleHier !== "kommandant" &&
          ziel.rolleHier !== "stellvertretung"
        ) {
          throw new HTTPException(400);
        }
        await db.transaction(async (tx) => {
          if (aenderung.name !== undefined) {
            // Der Name einer Person mit eigenem Konto gehört zu ihrer Teilnahme und ändert sich dort
            const [selbst] = await tx
              .select({ userId: teilnehmendeKonto.userId })
              .from(teilnehmendeKonto)
              .where(
                and(
                  eq(teilnehmendeKonto.userId, userId),
                  eq(teilnehmendeKonto.art, "selbst"),
                ),
              )
              .limit(1);
            if (selbst) throw new HTTPException(400);
          }
          if (aenderung.rangId !== undefined) {
            // Der Rang hängt an der Rolle: Eltern haben keinen
            if (!ziel.rolleHier) throw new HTTPException(400);
            if (aenderung.rangId !== null) {
              const [eigener] = await tx
                .select({ id: rang.id, typ: rang.typ })
                .from(rang)
                .where(
                  and(
                    eq(rang.id, aenderung.rangId),
                    eq(rang.einheitId, einheitId),
                  ),
                );
              // Leitende tragen Miliz-Ränge, Teilnehmende die der Einheit
              if (!eigener || eigener.typ !== "miliz") {
                throw new HTTPException(400);
              }
            }
            await tx
              .update(einheitRolle)
              .set({ rangId: aenderung.rangId })
              .where(
                and(
                  eq(einheitRolle.userId, userId),
                  eq(einheitRolle.einheitId, einheitId),
                ),
              );
          }
          const felder: Partial<{ name: string; telefon: string | null }> = {};
          if (aenderung.name !== undefined) felder.name = aenderung.name;
          if (aenderung.telefon !== undefined) {
            felder.telefon = aenderung.telefon;
          }
          if (Object.keys(felder).length > 0) {
            await tx.update(user).set(felder).where(eq(user.id, userId));
          }
          // Welche Felder, nie die Werte: Name und Nummer gehören nicht ins Protokoll
          await protokolliere(tx, {
            einheitId,
            akteurId: person.id,
            aktion: "person_geaendert",
            zielTyp: "person",
            zielId: userId,
            details: { felder: Object.keys(aenderung) },
          });
        });
        return c.body(null, 204);
      },
    )
    .put(
      "/:userId/rolle",
      eingabe("param", zielPfad),
      eingabe("json", rolleSchema),
      async (c) => {
        // Befördert eine Leitung zur Stellvertretung oder stuft sie zurück; Konto, Rang und Telefon bleiben. Recht wie bei den Stellvertretungen: nur das Kommando (und der Kantonsadmin)
        const person = c.get("person");
        const { einheitId, userId } = c.req.valid("param");
        const { rolle } = c.req.valid("json");
        await pruefeEinheit(db, person, einheitId, "stellvertretungen");
        await db.transaction(async (tx) => {
          await sperreStellvertretungen(tx, einheitId);
          const [bisher] = await tx
            .select({ typ: einheitRolle.typ })
            .from(einheitRolle)
            .where(
              and(
                eq(einheitRolle.einheitId, einheitId),
                eq(einheitRolle.userId, userId),
              ),
            );
          if (!bisher) throw new HTTPException(404);
          if (bisher.typ === "kommandant") throw new Konflikt("ROLLE_KOMMANDO");
          if (bisher.typ === rolle) throw new Konflikt("ROLLE_GLEICH");
          await tx
            .update(einheitRolle)
            .set({
              typ: rolle,
              // Eine neue Stellvertretung kommt ans Ende; die Lücke einer zurückgestuften schliesst sich beim Zählen
              reihenfolge:
                rolle === "stellvertretung"
                  ? sql`(select coalesce(max(${einheitRolle.reihenfolge}), 0) + 1 from ${einheitRolle} where ${stellvertretungen(einheitId)})`
                  : null,
            })
            .where(
              and(
                eq(einheitRolle.einheitId, einheitId),
                eq(einheitRolle.userId, userId),
              ),
            );
          await protokolliere(tx, {
            einheitId,
            akteurId: person.id,
            aktion: "rolle_geaendert",
            zielTyp: "person",
            zielId: userId,
            details: { von: bisher.typ, nach: rolle },
          });
        });
        return c.body(null, 204);
      },
    )
    .get("/:userId/startpasswort", eingabe("param", zielPfad), async (c) => {
      const person = c.get("person");
      const { einheitId, userId } = c.req.valid("param");
      const ziel = await ladeZiel(person, einheitId, userId);
      pruefeAktion(person, einheitId, ziel, "startpasswort");
      const [konto] = await db
        .select({
          mussPasswortAendern: user.mussPasswortAendern,
          gueltigBis: user.startpasswortGueltigBis,
          verschluesselt: user.startpasswortVerschluesselt,
        })
        .from(user)
        .where(eq(user.id, userId));
      const startpasswort =
        konto.mussPasswortAendern &&
        konto.gueltigBis &&
        konto.gueltigBis > new Date()
          ? entschluesseleStartpasswort(konto.verschluesselt)
          : null;
      // Abgelaufen, ersetzt oder nach einem Wechsel des Geheimnisses unlesbar: ein neues erzeugen
      if (!startpasswort) throw new Konflikt("KEIN_STARTPASSWORT");
      await protokolliere(db, {
        einheitId,
        akteurId: person.id,
        aktion: "startpasswort_angezeigt",
        zielTyp: "person",
        zielId: userId,
      });
      return c.json({ startpasswort, gueltigBis: konto.gueltigBis });
    })
    .post("/:userId/startpasswort", eingabe("param", zielPfad), async (c) => {
      const person = c.get("person");
      const { einheitId, userId } = c.req.valid("param");
      const ziel = await ladeZiel(person, einheitId, userId);
      // Vor jeder Änderung: Ein Reset auf sich selbst meldete die Person ab, bevor sie das Passwort kennt
      pruefeAktion(person, einheitId, ziel, "startpasswort");
      const startpasswort = erzeugeStartpasswort();
      // Derselbe scrypt-Hash wie bei better-auth, aber ohne die Hülle des Plugins haveIBeenPwned: Sie braucht eine Anfrage an better-auth, und ein zufälliges Startpasswort braucht keine Prüfung auf Leaks
      const hash = await hashPassword(normalisiereStartpasswort(startpasswort));
      const felder = startpasswortFelder(new Date(), startpasswort);
      const ergebnis = await db.transaction(async (tx) => {
        const geaendert = await tx
          .update(account)
          .set({ password: hash, updatedAt: sql`now()` })
          .where(
            and(
              eq(account.userId, userId),
              eq(account.providerId, "credential"),
            ),
          )
          .returning({ id: account.id });
        // Ein Konto ohne Passwort-Zugang gibt es nur durch einen Fehler im Anlegen
        if (geaendert.length === 0) throw new HTTPException(404);
        // Alle Sitzungen enden, die Push-Tokens mit ihnen (CASCADE); danach Pflichtwechsel, 7 Tage und Bremse von vorn
        await tx.delete(session).where(eq(session.userId, userId));
        await tx.update(user).set(felder).where(eq(user.id, userId));
        await protokolliere(tx, {
          einheitId,
          akteurId: person.id,
          aktion: "startpasswort_neu",
          zielTyp: "person",
          zielId: userId,
        });
        return { startpasswort, gueltigBis: felder.startpasswortGueltigBis };
      });
      // Die Antwort erst nach dem Commit: Ein zurückgenommenes Startpasswort darf sie nie erreichen
      return c.json(ergebnis);
    })
    .post("/:userId/deaktivieren", eingabe("param", zielPfad), async (c) => {
      const person = c.get("person");
      const { einheitId, userId } = c.req.valid("param");
      const ziel = await ladeZiel(person, einheitId, userId);
      pruefeAktion(person, einheitId, ziel, "deaktivieren");
      await db.transaction(async (tx) => {
        // Beide Felder: jedes allein beendet die Mitgliedschaft (aktivesKonto)
        await tx
          .update(user)
          .set({ banned: true, deaktiviertAm: sql`now()` })
          .where(eq(user.id, userId));
        await tx.delete(session).where(eq(session.userId, userId));
        // Das Profilbild geht mit dem Deaktivieren; Aktivieren bringt es nicht zurück
        await tx.delete(profilbild).where(eq(profilbild.userId, userId));
        await protokolliere(tx, {
          einheitId,
          akteurId: person.id,
          aktion: "person_deaktiviert",
          zielTyp: "person",
          zielId: userId,
        });
      });
      return c.body(null, 204);
    })
    .post("/:userId/aktivieren", eingabe("param", zielPfad), async (c) => {
      const person = c.get("person");
      const { einheitId, userId } = c.req.valid("param");
      const ziel = await ladeZiel(person, einheitId, userId);
      pruefeAktion(person, einheitId, ziel, "deaktivieren");
      await db.transaction(async (tx) => {
        await tx
          .update(user)
          .set({ banned: false, deaktiviertAm: null })
          .where(eq(user.id, userId));
        await protokolliere(tx, {
          einheitId,
          akteurId: person.id,
          aktion: "person_aktiviert",
          zielTyp: "person",
          zielId: userId,
        });
      });
      return c.body(null, 204);
    })
    .post(
      "/:userId/zweiter-faktor-zuruecksetzen",
      eingabe("param", zielPfad),
      async (c) => {
        const person = c.get("person");
        const { einheitId, userId } = c.req.valid("param");
        const ziel = await ladeZiel(person, einheitId, userId);
        pruefeAktion(person, einheitId, ziel, "zweiterFaktor");
        const zurueckgesetzt = await setzeZweitenFaktorZurueck(db, {
          zielId: userId,
          akteurId: person.id,
          einheitId,
        });
        if (!zurueckgesetzt) throw new Konflikt("KEIN_ZWEITER_FAKTOR");
        return c.body(null, 204);
      },
    );
}
