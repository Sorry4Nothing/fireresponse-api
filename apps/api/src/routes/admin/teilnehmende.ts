import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import {
  rang,
  teilnehmende,
  teilnehmendeKonto,
  user,
} from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import {
  erlaubteAktionen,
  gemeinsameKonten,
  kontoZustand,
} from "../../konto-verwaltung.js";
import {
  benutzernameFeld,
  erstelleKontoFabrik,
  findeElternKonto,
  namensfeld,
  neuesKontoSchema,
  protokolliere,
  verknuepfeKonto,
  type Tx,
} from "../../konten.js";
import { pruefeEinheit, type Person } from "../../rechte.js";

const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const zielPfad = z.strictObject({
  einheitId: z.uuid(),
  teilnehmendeId: z.uuid(),
});

// Ein Elternteil ist ein neues Konto oder ein bestehendes, das schon für ein anderes Kind antwortet (Eltern mit Kindern in zwei Einheiten haben ein Konto)
const elternSchema = z.union([
  neuesKontoSchema,
  z.strictObject({ bestehendesKonto: benutzernameFeld }),
]);
type Eltern = z.infer<typeof elternSchema>;

const anlegenSchema = z.strictObject({
  vorname: namensfeld,
  nachname: namensfeld,
  rangId: z.uuid().optional(),
  // Das Kommando legt fest, wer antwortet: die Eltern oder die Person selbst
  antwort: z.discriminatedUnion("art", [
    z.strictObject({
      art: z.literal("selbst"),
      benutzername: benutzernameFeld,
    }),
    z.strictObject({
      art: z.literal("eltern"),
      eltern: z.array(elternSchema).max(4),
    }),
  ]),
});
const aendernSchema = z
  .strictObject({
    vorname: namensfeld,
    nachname: namensfeld,
    rangId: z.uuid().nullable(),
    // false setzt die Person auf inaktiv (sie bleibt, antwortet aber nicht mehr), true macht sie wieder aktiv
    aktiv: z.boolean(),
  })
  .partial()
  .refine((b) => Object.values(b).some((wert) => wert !== undefined));
const elternAnlegenSchema = z.strictObject({ eltern: elternSchema });
const wechselSchema = z.strictObject({ benutzername: benutzernameFeld });

interface Verknuepft {
  userId: string;
  benutzername: string;
  art: "eltern" | "selbst";
  // Nur bei einem neuen Konto; ein bestehendes behält sein Passwort
  startpasswort?: string;
}

type Fabrik = ReturnType<typeof erstelleKontoFabrik>;
interface Kontext {
  einheitId: string;
  akteurId: string;
}

// Teilnehmende der Einheit aus der URL, mit Zeilensperre: Verknüpfungen derselben Person laufen nacheinander. Eine Person einer anderen Einheit ist 404
async function ladeZiel(tx: Tx, einheitId: string, id: string) {
  const [ziel] = await tx
    .select({
      id: teilnehmende.id,
      vorname: teilnehmende.vorname,
      nachname: teilnehmende.nachname,
    })
    .from(teilnehmende)
    .where(and(eq(teilnehmende.id, id), eq(teilnehmende.einheitId, einheitId)))
    .for("no key update");
  if (!ziel) throw new HTTPException(404);
  return ziel;
}

async function verknuepfeEltern(
  tx: Tx,
  fabrik: Fabrik,
  ctx: Kontext & { teilnehmendeId: string },
  eltern: Eltern,
): Promise<Verknuepft> {
  let ergebnis: Omit<Verknuepft, "art">;
  if ("bestehendesKonto" in eltern) {
    // Unbekannte, deaktivierte und ungeeignete Konten sind eine ungültige Eingabe
    const id = await findeElternKonto(tx, eltern.bestehendesKonto);
    if (!id) throw new HTTPException(400);
    ergebnis = {
      userId: id,
      benutzername: eltern.bestehendesKonto.toLowerCase(),
    };
  } else {
    const konto = await fabrik(eltern);
    ergebnis = {
      userId: konto.id,
      benutzername: konto.benutzername,
      startpasswort: konto.startpasswort,
    };
    await protokolliere(tx, {
      einheitId: ctx.einheitId,
      akteurId: ctx.akteurId,
      aktion: "person_angelegt",
      zielTyp: "person",
      zielId: konto.id,
      details: { rolle: "eltern" },
    });
  }
  await verknuepfeKonto(tx, {
    teilnehmendeId: ctx.teilnehmendeId,
    userId: ergebnis.userId,
    art: "eltern",
  });
  await protokolliere(tx, {
    einheitId: ctx.einheitId,
    akteurId: ctx.akteurId,
    aktion: "eltern_verknuepft",
    zielTyp: "teilnehmende",
    zielId: ctx.teilnehmendeId,
    details: { userId: ergebnis.userId },
  });
  return { ...ergebnis, art: "eltern" };
}

// Das eigene Konto der Person: Name wie die Person, neues Startpasswort
async function legeSelbstKontoAn(
  tx: Tx,
  fabrik: Fabrik,
  ctx: Kontext,
  ziel: { id: string; vorname: string; nachname: string },
  benutzername: string,
): Promise<Verknuepft> {
  const konto = await fabrik({
    vorname: ziel.vorname,
    nachname: ziel.nachname,
    benutzername,
  });
  await protokolliere(tx, {
    einheitId: ctx.einheitId,
    akteurId: ctx.akteurId,
    aktion: "person_angelegt",
    zielTyp: "person",
    zielId: konto.id,
    details: { rolle: "selbst" },
  });
  await verknuepfeKonto(tx, {
    teilnehmendeId: ziel.id,
    userId: konto.id,
    art: "selbst",
  });
  return {
    userId: konto.id,
    benutzername: konto.benutzername,
    art: "selbst",
    startpasswort: konto.startpasswort,
  };
}

export function erstelleTeilnehmendeRouten({ db }: { db: Db }) {
  return (
    new Hono<{ Variables: { person: Person } }>()
      // Alle Personen der Einheit mit Rang und den Konten, die für sie antworten; ein Eintrag ohne Konto heisst: Es antwortet niemand
      .get("/", eingabe("param", einheitPfad), async (c) => {
        const person = c.get("person");
        const { einheitId } = c.req.valid("param");
        await pruefeEinheit(db, person, einheitId, "verwalten");
        const personen = await db
          .select({
            id: teilnehmende.id,
            vorname: teilnehmende.vorname,
            nachname: teilnehmende.nachname,
            inaktivSeit: teilnehmende.inaktivSeit,
            rangId: rang.id,
            rangName: rang.name,
          })
          .from(teilnehmende)
          .leftJoin(rang, eq(rang.id, teilnehmende.rangId))
          .where(eq(teilnehmende.einheitId, einheitId))
          .orderBy(
            asc(teilnehmende.nachname),
            asc(teilnehmende.vorname),
            asc(teilnehmende.id),
          );
        const konten =
          personen.length === 0
            ? []
            : await db
                .select({
                  teilnehmendeId: teilnehmendeKonto.teilnehmendeId,
                  art: teilnehmendeKonto.art,
                  id: user.id,
                  name: user.name,
                  benutzername: user.username,
                  twoFactorEnabled: user.twoFactorEnabled,
                  mussPasswortAendern: user.mussPasswortAendern,
                  startpasswortGueltigBis: user.startpasswortGueltigBis,
                  banned: user.banned,
                  deaktiviertAm: user.deaktiviertAm,
                })
                .from(teilnehmendeKonto)
                .innerJoin(user, eq(user.id, teilnehmendeKonto.userId))
                .where(
                  inArray(
                    teilnehmendeKonto.teilnehmendeId,
                    personen.map((p) => p.id),
                  ),
                )
                .orderBy(asc(user.name), asc(user.id));
        const gemeinsam = await gemeinsameKonten(
          db,
          einheitId,
          konten.map((k) => k.id),
        );
        return c.json({
          teilnehmende: personen.map((p) => ({
            id: p.id,
            vorname: p.vorname,
            nachname: p.nachname,
            aktiv: p.inaktivSeit === null,
            rang: p.rangId ? { id: p.rangId, name: p.rangName } : null,
            konten: konten
              .filter((k) => k.teilnehmendeId === p.id)
              .map((k) => ({
                id: k.id,
                name: k.name,
                benutzername: k.benutzername,
                art: k.art,
                eigenes: k.id === person.id,
                gemeinsam: gemeinsam.has(k.id),
                ...kontoZustand(k),
                aktionen: erlaubteAktionen(person, einheitId, {
                  id: k.id,
                  name: k.name,
                  rolleHier: null,
                  gemeinsam: gemeinsam.has(k.id),
                }),
              })),
          })),
        });
      })
      .patch(
        "/:teilnehmendeId",
        eingabe("param", zielPfad),
        eingabe("json", aendernSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId, teilnehmendeId } = c.req.valid("param");
          const aenderung = c.req.valid("json");
          await pruefeEinheit(db, person, einheitId, "verwalten");
          await db.transaction(async (tx) => {
            const ziel = await ladeZiel(tx, einheitId, teilnehmendeId);
            if (aenderung.rangId) {
              // Ein Rang einer anderen Einheit ist eine ungültige Eingabe, kein 404 der URL
              const [eigener] = await tx
                .select({ id: rang.id, typ: rang.typ })
                .from(rang)
                .where(
                  and(
                    eq(rang.id, aenderung.rangId),
                    eq(rang.einheitId, einheitId),
                  ),
                );
              // Miliz-Ränge gehören den Leitenden
              if (!eigener || eigener.typ === "miliz") {
                throw new HTTPException(400);
              }
            }
            const felder: PgUpdateSetSource<typeof teilnehmende> = {};
            if (aenderung.vorname !== undefined) {
              felder.vorname = aenderung.vorname;
            }
            if (aenderung.nachname !== undefined) {
              felder.nachname = aenderung.nachname;
            }
            if (aenderung.rangId !== undefined)
              felder.rangId = aenderung.rangId;
            if (aenderung.aktiv === true) felder.inaktivSeit = null;
            if (aenderung.aktiv === false) {
              // Das erste Datum bleibt: Wer schon inaktiv ist, behält seinen Zeitpunkt
              felder.inaktivSeit = sql`coalesce(${teilnehmende.inaktivSeit}, now())`;
            }
            await tx
              .update(teilnehmende)
              .set(felder)
              .where(eq(teilnehmende.id, teilnehmendeId));
            if (
              aenderung.vorname !== undefined ||
              aenderung.nachname !== undefined
            ) {
              // Das eigene Konto trägt den Namen der Person
              await tx
                .update(user)
                .set({
                  name: `${aenderung.vorname ?? ziel.vorname} ${aenderung.nachname ?? ziel.nachname}`,
                })
                .where(
                  inArray(
                    user.id,
                    tx
                      .select({ id: teilnehmendeKonto.userId })
                      .from(teilnehmendeKonto)
                      .where(
                        and(
                          eq(teilnehmendeKonto.teilnehmendeId, teilnehmendeId),
                          eq(teilnehmendeKonto.art, "selbst"),
                        ),
                      ),
                  ),
                );
            }
            // Welche Felder, nie die Namen
            await protokolliere(tx, {
              einheitId,
              akteurId: person.id,
              aktion: "teilnehmende_geaendert",
              zielTyp: "teilnehmende",
              zielId: teilnehmendeId,
              details: { felder: Object.keys(aenderung) },
            });
          });
          return c.body(null, 204);
        },
      )
      .post(
        "/",
        eingabe("param", einheitPfad),
        eingabe("json", anlegenSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId } = c.req.valid("param");
          const { vorname, nachname, rangId, antwort } = c.req.valid("json");
          await pruefeEinheit(db, person, einheitId, "verwalten");
          const ergebnis = await db.transaction(async (tx) => {
            if (rangId) {
              // Ein Rang einer anderen Einheit ist eine ungültige Eingabe, kein 404 der URL
              const [eigener] = await tx
                .select({ id: rang.id, typ: rang.typ })
                .from(rang)
                .where(and(eq(rang.id, rangId), eq(rang.einheitId, einheitId)));
              // Miliz-Ränge gehören den Leitenden
              if (!eigener || eigener.typ === "miliz") {
                throw new HTTPException(400);
              }
            }
            const [neu] = await tx
              .insert(teilnehmende)
              .values({ einheitId, vorname, nachname, rangId })
              .returning({ id: teilnehmende.id });
            await protokolliere(tx, {
              einheitId,
              akteurId: person.id,
              aktion: "teilnehmende_angelegt",
              zielTyp: "teilnehmende",
              zielId: neu.id,
              details: { antwort: antwort.art },
            });
            const fabrik = erstelleKontoFabrik(tx);
            const ctx = { einheitId, akteurId: person.id };
            const konten: Verknuepft[] = [];
            if (antwort.art === "selbst") {
              konten.push(
                await legeSelbstKontoAn(
                  tx,
                  fabrik,
                  ctx,
                  { id: neu.id, vorname, nachname },
                  antwort.benutzername,
                ),
              );
            } else {
              for (const eltern of antwort.eltern) {
                konten.push(
                  await verknuepfeEltern(
                    tx,
                    fabrik,
                    { ...ctx, teilnehmendeId: neu.id },
                    eltern,
                  ),
                );
              }
            }
            return { id: neu.id, konten };
          });
          // 201 erst nach dem Commit: Ein zurückgenommenes Startpasswort darf die Antwort nie erreichen
          return c.json(ergebnis, 201);
        },
      )
      .post(
        "/:teilnehmendeId/eltern",
        eingabe("param", zielPfad),
        eingabe("json", elternAnlegenSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId, teilnehmendeId } = c.req.valid("param");
          const { eltern } = c.req.valid("json");
          await pruefeEinheit(db, person, einheitId, "verwalten");
          const ergebnis = await db.transaction(async (tx) => {
            await ladeZiel(tx, einheitId, teilnehmendeId);
            return verknuepfeEltern(
              tx,
              erstelleKontoFabrik(tx),
              { einheitId, teilnehmendeId, akteurId: person.id },
              eltern,
            );
          });
          return c.json(ergebnis, 201);
        },
      )
      // Die Familie meldet sich beim Kommando: Die Person bekommt ein eigenes Konto, die Verknüpfungen der Eltern fallen weg, alles in einer Transaktion. Danach ist die Person für die früheren Eltern unsichtbar (404)
      .post(
        "/:teilnehmendeId/konto-wechsel",
        eingabe("param", zielPfad),
        eingabe("json", wechselSchema),
        async (c) => {
          const person = c.get("person");
          const { einheitId, teilnehmendeId } = c.req.valid("param");
          const { benutzername } = c.req.valid("json");
          await pruefeEinheit(db, person, einheitId, "verwalten");
          const ergebnis = await db.transaction(async (tx) => {
            const ziel = await ladeZiel(tx, einheitId, teilnehmendeId);
            const entfernt = await tx
              .delete(teilnehmendeKonto)
              .where(
                and(
                  eq(teilnehmendeKonto.teilnehmendeId, teilnehmendeId),
                  eq(teilnehmendeKonto.art, "eltern"),
                ),
              )
              .returning({ userId: teilnehmendeKonto.userId });
            const neu = await legeSelbstKontoAn(
              tx,
              erstelleKontoFabrik(tx),
              { einheitId, akteurId: person.id },
              ziel,
              benutzername,
            );
            await protokolliere(tx, {
              einheitId,
              akteurId: person.id,
              aktion: "konto_gewechselt",
              zielTyp: "teilnehmende",
              zielId: teilnehmendeId,
              details: {
                neuesKonto: neu.userId,
                entfernteEltern: entfernt.length,
              },
            });
            return neu;
          });
          return c.json(ergebnis, 201);
        },
      )
  );
}
