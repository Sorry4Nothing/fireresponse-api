import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { teilnehmende, user } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import {
  alsErgebnis,
  personSchluessel,
  pruefeZeilen,
} from "../../import-regeln.js";
import {
  erstelleKontoFabrik,
  protokolliere,
  sperreEinheit,
  verknuepfeKonto,
} from "../../konten.js";
import { pruefeEinheit, type Person } from "../../rechte.js";

const einheitPfad = z.strictObject({ einheitId: z.uuid() });
// Ein Schema für beide Routen. Zeilenfehler (leer, zu lang) sind kein 400, sondern der Status «ungueltig». Die Grenze hält den Body unter den 64 KB des globalen Limits
const importSchema = z.strictObject({
  zeilen: z
    .array(
      z.strictObject({
        vorname: z.string().max(200),
        nachname: z.string().max(200),
        art: z.enum(["eltern", "selbst", "ohne", "auslassen"]),
        elternVorname: z.string().max(200).optional(),
        elternNachname: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(200),
});

type Leser = Pick<Db, "select">;

// Der Bestand; Vorschau und Import lesen ihn je neu, dem Browser glaubt keine Route
async function ladeBestand(leser: Leser, einheitId: string) {
  const [personen, konten] = await Promise.all([
    leser
      .select({
        vorname: teilnehmende.vorname,
        nachname: teilnehmende.nachname,
      })
      .from(teilnehmende)
      .where(eq(teilnehmende.einheitId, einheitId)),
    // shortcut: alle Benutzernamen des Systems, damit ein Vorschlag nie kollidiert; bei mehreren Tausend Konten nach Vorsilbe filtern
    leser.select({ username: user.username }).from(user),
  ]);
  return {
    teilnehmende: new Set(
      personen.map((p) => personSchluessel(p.vorname, p.nachname)),
    ),
    benutzernamen: new Set(
      konten.flatMap((k) => (k.username ? [k.username.toLowerCase()] : [])),
    ),
  };
}

// Nur Teilnehmende und Eltern der eigenen Einheit: Alles Geschriebene gehört der Einheit aus der URL
export function erstelleImportRouten({ db }: { db: Db }) {
  return new Hono<{ Variables: { person: Person } }>()
    .post(
      "/vorschau",
      eingabe("param", einheitPfad),
      eingabe("json", importSchema),
      async (c) => {
        const person = c.get("person");
        const { einheitId } = c.req.valid("param");
        const { zeilen } = c.req.valid("json");
        await pruefeEinheit(db, person, einheitId, "verwalten");
        const { plan, summe } = pruefeZeilen(
          zeilen,
          await ladeBestand(db, einheitId),
        );
        return c.json({ zeilen: plan.map(alsErgebnis), summe });
      },
    )
    .post(
      "/",
      eingabe("param", einheitPfad),
      eingabe("json", importSchema),
      async (c) => {
        const person = c.get("person");
        const { einheitId } = c.req.valid("param");
        const { zeilen } = c.req.valid("json");
        await pruefeEinheit(db, person, einheitId, "verwalten");
        const antwort = await db.transaction(async (tx) => {
          // Zwei gleichzeitige Importe sähen sonst beide «neu»: Der zweite wartet und liest den Bestand nach dem Commit des ersten
          await sperreEinheit(tx, `import:${einheitId}`);
          const { plan, summe } = pruefeZeilen(
            zeilen,
            await ladeBestand(tx, einheitId),
          );
          const fabrik = erstelleKontoFabrik(tx);
          // Konto der Eltern je Zeilennummer, damit Geschwister es teilen
          const elternKonten = new Map<number, string>();
          const konten: {
            name: string;
            art: "eltern" | "selbst";
            benutzername: string;
            startpasswort: string;
          }[] = [];
          // shortcut: Konten nacheinander, jedes rechnet scrypt und fragt HIBP; bei 200 Zeilen dauert das Minuten, bei einer Einheit (rund 50) Sekunden. Parallel ginge nicht in einer Transaktion
          for (const p of plan) {
            if (p.status !== "neu") continue;
            const [neu] = await tx
              .insert(teilnehmende)
              .values({ einheitId, vorname: p.vorname!, nachname: p.nachname! })
              .returning({ id: teilnehmende.id });
            await protokolliere(tx, {
              einheitId,
              akteurId: person.id,
              aktion: "teilnehmende_angelegt",
              zielTyp: "teilnehmende",
              zielId: neu.id,
              details: { antwort: p.art, import: true },
            });
            if (p.art === "ohne") continue;
            const art = p.art as "eltern" | "selbst";
            let userId: string | undefined;
            if (p.gleicheEltern !== undefined) {
              userId = elternKonten.get(p.gleicheEltern);
            } else {
              const eltern = art === "eltern";
              const konto = await fabrik({
                vorname: eltern ? p.elternVorname! : p.vorname!,
                nachname: eltern ? p.elternNachname! : p.nachname!,
                benutzername: p.benutzername!,
              });
              await protokolliere(tx, {
                einheitId,
                akteurId: person.id,
                aktion: "person_angelegt",
                zielTyp: "person",
                zielId: konto.id,
                details: { rolle: art, import: true },
              });
              konten.push({
                name: eltern
                  ? `${p.elternVorname} ${p.elternNachname}`
                  : `${p.vorname} ${p.nachname}`,
                art,
                benutzername: konto.benutzername,
                startpasswort: konto.startpasswort,
              });
              userId = konto.id;
              if (eltern) elternKonten.set(p.nr, konto.id);
            }
            await verknuepfeKonto(tx, {
              teilnehmendeId: neu.id,
              userId: userId!,
              art,
            });
          }
          return {
            teilnehmende: summe.neu,
            konten,
            uebersprungen: zeilen.length - summe.neu,
          };
        });
        // 201 erst nach dem Commit: Ein zurückgenommenes Startpasswort darf die Antwort nie erreichen
        return c.json(antwort, 201);
      },
    );
}
