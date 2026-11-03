import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { einheitRolle, rang, user } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import { Konflikt } from "../../konflikt.js";
import {
  benutzernameFeld,
  erstelleKontoFabrik,
  neuesKontoSchema,
  protokolliere,
} from "../../konten.js";
import { aktivesKonto, pruefeEinheit, type Person } from "../../rechte.js";

const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const bestehendSchema = z.strictObject({ benutzername: benutzernameFeld });
const zielPfad = z.strictObject({ einheitId: z.uuid(), userId: z.uuid() });

// Leitende legen Kommando und Stellvertretungen an (und das Konto des Kantonsadmins). Leitende sind keine Kontakte und haben darum keine Nummer
export function erstelleLeitendeRouten({ db }: { db: Db }) {
  return (
    new Hono<{ Variables: { person: Person } }>()
      .post(
        "/",
        eingabe("param", einheitPfad),
        eingabe("json", neuesKontoSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId } = c.req.valid("param");
          const konto = c.req.valid("json");
          await pruefeEinheit(db, person, einheitId, "verwalten");
          const neu = await db.transaction(async (tx) => {
            const neu = await erstelleKontoFabrik(tx)(konto);
            await tx
              .insert(einheitRolle)
              .values({ userId: neu.id, einheitId, typ: "leitung" });
            await protokolliere(tx, {
              einheitId,
              akteurId: person.id,
              aktion: "person_angelegt",
              zielTyp: "person",
              zielId: neu.id,
              details: { rolle: "leitung" },
            });
            return neu;
          });
          // 201 erst nach dem Commit: Ein zurückgenommenes Startpasswort darf die Antwort nie erreichen
          return c.json(neu, 201);
        },
      )
      // Weist ein bestehendes Konto zusätzlich als Leitung zu (JF und KF mit einem Konto). Das Konto muss schon eine Rolle haben; das Kommando darf es nur, wenn es in einer dieser Einheiten selbst verwaltet. Unbekannt und nicht erlaubt antworten gleich (404), sonst liesse sich nach Benutzernamen suchen. Das Konto gilt danach als gemeinsam: Nur der Kantonsadmin setzt es zurück oder deaktiviert es
      .post(
        "/bestehend",
        eingabe("param", einheitPfad),
        eingabe("json", bestehendSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId } = c.req.valid("param");
          const { benutzername } = c.req.valid("json");
          await pruefeEinheit(db, person, einheitId, "verwalten");
          await db.transaction(async (tx) => {
            const [konto] = await tx
              .select({ id: user.id, role: user.role })
              .from(user)
              .where(
                and(
                  eq(user.username, benutzername.toLowerCase()),
                  aktivesKonto(),
                ),
              );
            const rollen = konto
              ? await tx
                  .select({
                    einheitId: einheitRolle.einheitId,
                    rangId: einheitRolle.rangId,
                  })
                  .from(einheitRolle)
                  .where(eq(einheitRolle.userId, konto.id))
              : [];
            const verwaltet = new Set(
              person.einheiten
                .filter((r) => r.typ !== "leitung")
                .map((r) => r.einheitId),
            );
            if (
              !konto ||
              konto.role === "admin" ||
              rollen.length === 0 ||
              (!person.kantonsadmin &&
                !rollen.some((r) => verwaltet.has(r.einheitId)))
            ) {
              throw new HTTPException(404);
            }
            if (rollen.some((r) => r.einheitId === einheitId)) {
              throw new Konflikt("ROLLE_GLEICH");
            }
            // Der Dienstgrad gehört zur Person, der Rang aber zu einer Einheit: In der Zieleinheit gilt der Miliz-Rang mit demselben Kürzel. Fehlt er dort, bleibt der Rang leer
            const quellRangIds = rollen.flatMap((r) =>
              r.rangId ? [r.rangId] : [],
            );
            const [quelle] = quellRangIds.length
              ? await tx
                  .select({ kuerzel: rang.kuerzel })
                  .from(rang)
                  .where(
                    and(inArray(rang.id, quellRangIds), eq(rang.typ, "miliz")),
                  )
              : [];
            const [ziel] = quelle
              ? await tx
                  .select({ id: rang.id })
                  .from(rang)
                  .where(
                    and(
                      eq(rang.einheitId, einheitId),
                      eq(rang.typ, "miliz"),
                      eq(rang.kuerzel, quelle.kuerzel),
                    ),
                  )
              : [];
            await tx.insert(einheitRolle).values({
              userId: konto.id,
              einheitId,
              typ: "leitung",
              rangId: ziel?.id ?? null,
            });
            await protokolliere(tx, {
              einheitId,
              akteurId: person.id,
              aktion: "person_zugewiesen",
              zielTyp: "person",
              zielId: konto.id,
              details: { rolle: "leitung" },
            });
          });
          return c.body(null, 204);
        },
      )
      // Entfernt nur die Rolle «Leitung»; das Konto bleibt (die Person ist dann ohne Einheit). Kommando und Stellvertretungen gehen über die Übergabe und die Stellvertretungen
      .delete("/:userId", eingabe("param", zielPfad), async (c) => {
        const person = c.get("person");
        const { einheitId, userId } = c.req.valid("param");
        await pruefeEinheit(db, person, einheitId, "verwalten");
        await db.transaction(async (tx) => {
          const entfernt = await tx
            .delete(einheitRolle)
            .where(
              and(
                eq(einheitRolle.einheitId, einheitId),
                eq(einheitRolle.userId, userId),
                eq(einheitRolle.typ, "leitung"),
              ),
            )
            .returning({ userId: einheitRolle.userId });
          if (entfernt.length === 0) throw new HTTPException(404);
          await protokolliere(tx, {
            einheitId,
            akteurId: person.id,
            aktion: "leitung_entfernt",
            zielTyp: "person",
            zielId: userId,
          });
        });
        return c.body(null, 204);
      })
  );
}
