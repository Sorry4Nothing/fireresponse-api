import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  ABZEICHEN_MAX_BYTES,
  AbzeichenFehler,
  pruefeLogo,
} from "../../abzeichen.js";
import type { Db } from "../../db/client.js";
import {
  bezirk,
  einheit,
  einheitRolle,
  teilnehmende,
  user,
} from "../../db/schema.js";
import {
  legeEinheitAn,
  adminLogoUrl,
  uebergibKommando,
  UebergabeFehler,
} from "../../einheiten.js";
import { eingabe } from "../../eingabe.js";
import { logoAntwort } from "../logo.js";
import { eindeutigkeitsVerstoss, Konflikt } from "../../konflikt.js";
import {
  erstelleKontoFabrik,
  neuesKontoMitTelefonSchema,
  protokolliere,
} from "../../konten.js";
import {
  aktivesKonto,
  einheitenFuer,
  hatVerwaltung,
  pruefeEinheit,
  type Person,
} from "../../rechte.js";

const pfadSchema = z.strictObject({ einheitId: z.uuid() });
// Einheit und Kommandant/in entstehen zusammen; die Kommandantin oder der Kommandant bekommt ein neues Konto
const anlegenSchema = z.strictObject({
  bezirkId: z.uuid(),
  typ: z.enum(["jf", "kf"]),
  name: z.string().trim().min(1).max(100),
  kommandant: neuesKontoMitTelefonSchema,
});
const uebergabeSchema = z.strictObject({
  neuerKommandantId: z.uuid(),
  // Die neue Rolle der bisherigen Kommandantin oder des bisherigen Kommandanten
  bisherigeRolle: z.discriminatedUnion("typ", [
    z.strictObject({
      typ: z.literal("stellvertretung"),
      reihenfolge: z.int().min(1).max(99),
    }),
    z.strictObject({ typ: z.literal("leitung") }),
    z.strictObject({ typ: z.literal("keine") }),
  ]),
});

const KONFLIKT = {
  KEIN_KOMMANDANT: {
    code: "KEIN_KOMMANDANT",
    message: "Die Einheit hat keine Kommandantin und keinen Kommandanten.",
  },
  GLEICHE_PERSON: {
    code: "GLEICHE_PERSON",
    message: "Diese Person ist schon Kommandantin oder Kommandant.",
  },
} as const;

export function erstelleEinheitenRouten({ db }: { db: Db }) {
  return (
    new Hono<{ Variables: { person: Person } }>()
      .get("/", async (c) => {
        const person = c.get("person");
        if (!hatVerwaltung(person)) throw new HTTPException(403);
        const ids = await einheitenFuer(db, person, "verwalten");
        const zeilen = await db
          .select({
            id: einheit.id,
            name: einheit.name,
            typ: einheit.typ,
            bezirkId: einheit.bezirkId,
            bezirk: bezirk.name,
            logoUrl: adminLogoUrl,
            kommandantId: user.id,
            kommandantName: user.name,
            lodur: einheit.lodurUrlVerschluesselt,
            syncOkAm: einheit.syncOkAm,
            syncFehler: einheit.syncFehler,
            teilnehmende: sql<number>`(select count(*) from ${teilnehmende} where ${teilnehmende.einheitId} = ${einheit.id} and ${teilnehmende.inaktivSeit} is null)::int`,
          })
          .from(einheit)
          .innerJoin(bezirk, eq(bezirk.id, einheit.bezirkId))
          .leftJoin(
            einheitRolle,
            and(
              eq(einheitRolle.einheitId, einheit.id),
              eq(einheitRolle.typ, "kommandant"),
            ),
          )
          .leftJoin(user, eq(user.id, einheitRolle.userId))
          .where(inArray(einheit.id, ids))
          .orderBy(asc(bezirk.name), asc(einheit.typ));
        // Nie der Link selbst: nur ob einer hinterlegt ist, und der Stand des Syncs
        const einheiten = zeilen.map(
          ({ lodur, kommandantId, kommandantName, ...z }) => ({
            ...z,
            kommandant: kommandantId
              ? { id: kommandantId, name: kommandantName }
              : null,
            lodurHinterlegt: lodur !== null,
            // Die Rolle der Person in dieser Einheit; das Konto des Kantonsadmins hat keine
            rolle:
              person.einheiten.find((r) => r.einheitId === z.id)?.typ ?? null,
          }),
        );
        return c.json({ einheiten });
      })
      .post("/", eingabe("json", anlegenSchema), async (c) => {
        const person = c.get("person");
        if (!person.kantonsadmin) throw new HTTPException(403);
        const { bezirkId, typ, name, kommandant } = c.req.valid("json");
        try {
          const ergebnis = await db.transaction(async (tx) => {
            const [ziel] = await tx
              .select({ id: bezirk.id })
              .from(bezirk)
              .where(eq(bezirk.id, bezirkId));
            if (!ziel) throw new HTTPException(400);
            const [vorhanden] = await tx
              .select({ id: einheit.id })
              .from(einheit)
              .where(and(eq(einheit.bezirkId, bezirkId), eq(einheit.typ, typ)));
            if (vorhanden) throw new Konflikt("EINHEIT_VORHANDEN");
            const konto = await erstelleKontoFabrik(tx)(kommandant);
            const einheitId = await legeEinheitAn(tx, {
              bezirkId,
              typ,
              name,
              kommandantId: konto.id,
              akteurId: person.id,
            });
            await protokolliere(tx, {
              einheitId,
              akteurId: person.id,
              aktion: "person_angelegt",
              zielTyp: "person",
              zielId: konto.id,
              details: { rolle: "kommandant" },
            });
            return { id: einheitId, kommandant: konto };
          });
          // 201 erst nach dem Commit: Ein zurückgenommenes Startpasswort darf die Antwort nie erreichen
          return c.json(ergebnis, 201);
        } catch (fehler) {
          // Zwei gleichzeitige Anfragen für denselben Bezirk und dieselbe Art: Die zweite scheitert am Index
          if (
            eindeutigkeitsVerstoss(fehler) === "einheit_bezirk_typ_eindeutig"
          ) {
            throw new Konflikt("EINHEIT_VORHANDEN");
          }
          throw fehler;
        }
      })
      .get("/:einheitId/logo", eingabe("param", pfadSchema), async (c) => {
        const person = c.get("person");
        const { einheitId } = c.req.valid("param");
        await pruefeEinheit(db, person, einheitId, "verwalten");
        return logoAntwort(c, db, einheitId);
      })
      // Der Body ist das Bild selbst (SVG oder PNG, quadratisch, höchstens 500 KB); der Typ ergibt sich aus den Bytes. Gespeichert wird das bereinigte Ergebnis, nie die Eingabe
      .put(
        "/:einheitId/logo",
        bodyLimit({ maxSize: ABZEICHEN_MAX_BYTES }),
        eingabe("param", pfadSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId } = c.req.valid("param");
          await pruefeEinheit(db, person, einheitId, "verwalten");
          let bild;
          try {
            bild = pruefeLogo(new Uint8Array(await c.req.arrayBuffer()));
          } catch (fehler) {
            if (fehler instanceof AbzeichenFehler) {
              return c.json(
                { code: "LOGO_UNGUELTIG", message: fehler.message },
                415,
              );
            }
            throw fehler;
          }
          await db.transaction(async (tx) => {
            await tx
              .update(einheit)
              .set({ logoBild: bild.inhalt, logoBildTyp: bild.typ })
              .where(eq(einheit.id, einheitId));
            await protokolliere(tx, {
              einheitId,
              akteurId: person.id,
              aktion: "einheit_logo_gesetzt",
              zielTyp: "einheit",
              zielId: einheitId,
            });
          });
          return c.body(null, 204);
        },
      )
      // Ohne Logo ebenfalls 204: Das Ziel ist erreicht
      .delete("/:einheitId/logo", eingabe("param", pfadSchema), async (c) => {
        const person = c.get("person");
        const { einheitId } = c.req.valid("param");
        await pruefeEinheit(db, person, einheitId, "verwalten");
        await db.transaction(async (tx) => {
          await tx
            .update(einheit)
            .set({ logoBild: null, logoBildTyp: null })
            .where(eq(einheit.id, einheitId));
          await protokolliere(tx, {
            einheitId,
            akteurId: person.id,
            aktion: "einheit_logo_entfernt",
            zielTyp: "einheit",
            zielId: einheitId,
          });
        });
        return c.body(null, 204);
      })
      .post(
        "/:einheitId/kommando",
        eingabe("param", pfadSchema),
        eingabe("json", uebergabeSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId } = c.req.valid("param");
          const { neuerKommandantId, bisherigeRolle } = c.req.valid("json");
          // Fremde wie unbekannte Einheiten sind 404, erst danach zählt das Recht
          await pruefeEinheit(db, person, einheitId, "lesen");
          if (!person.kantonsadmin) throw new HTTPException(403);
          try {
            await db.transaction(async (tx) => {
              // Aktiv und kein Kantonsadmin-Konto: Es würde das Kommando einer Einheit ohne eigene Rolle führen
              const [ziel] = await tx
                .select({ role: user.role })
                .from(user)
                .where(and(eq(user.id, neuerKommandantId), aktivesKonto()));
              if (!ziel || ziel.role === "admin") throw new HTTPException(400);
              await uebergibKommando(tx, {
                einheitId,
                neuerKommandantId,
                bisherige: bisherigeRolle,
                akteurId: person.id,
              });
            });
          } catch (fehler) {
            if (fehler instanceof UebergabeFehler) {
              return c.json(KONFLIKT[fehler.code], 409);
            }
            throw fehler;
          }
          return c.body(null, 204);
        },
      )
  );
}
