import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { rang, teilnehmende, teilnehmendeKonto } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
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
                .select({ id: rang.id })
                .from(rang)
                .where(and(eq(rang.id, rangId), eq(rang.einheitId, einheitId)));
              if (!eigener) throw new HTTPException(400);
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
