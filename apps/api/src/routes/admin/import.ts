import { isAPIError } from "better-auth/api";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { kind, stufe, user } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import {
  alsErgebnis,
  normalisiereName,
  personSchluessel,
  pruefeZeilen,
} from "../../import-regeln.js";
import { legePersonAn } from "../../personen-anlegen.js";
import type { Person } from "../../rechte.js";
import { erzeugeStartpasswort } from "../../startpasswort.js";

// Ein Schema für beide Routen. Zeilenfehler (leer, zu lang) sind kein 400, sondern der Status «ungueltig»
const importSchema = z.strictObject({
  stufeId: z.uuid(),
  zeilen: z
    .array(
      z.strictObject({
        vorname: z.string().max(200),
        nachname: z.string().max(200),
        art: z.enum(["kind", "leitung", "stufenleitung", "auslassen"]),
      }),
    )
    .min(1)
    .max(500),
});

export function erstelleImportRouten({ db }: { db: Db }) {
  // Eine fremde oder unbekannte Stufe ist eine ungültige Eingabe, vor jedem Schreibzugriff geprüft
  async function pruefeStufe(person: Person, stufeId: string) {
    const [eigene] = await db
      .select({ id: stufe.id })
      .from(stufe)
      .where(
        and(eq(stufe.id, stufeId), eq(stufe.abteilungId, person.abteilungId)),
      );
    if (!eigene) throw new HTTPException(400);
  }

  // Der Bestand der Abteilung; Vorschau und Import lesen ihn je neu, dem Browser glaubt keine Route
  async function ladeBestand(leser: Pick<Db, "select">, abteilungId: string) {
    const [kinder, konten] = await Promise.all([
      leser
        .select({ vorname: kind.vorname, nachname: kind.nachname })
        .from(kind)
        .where(eq(kind.abteilungId, abteilungId)),
      leser
        .select({ name: user.name, username: user.username })
        .from(user)
        .where(eq(user.abteilungId, abteilungId)),
    ]);
    return {
      kinder: new Set(
        kinder.map((k) => personSchluessel(k.vorname, k.nachname)),
      ),
      konten: new Set(konten.map((k) => normalisiereName(k.name))),
      benutzernamen: new Set(
        konten.flatMap((k) => (k.username ? [k.username.toLowerCase()] : [])),
      ),
    };
  }

  return new Hono<{ Variables: { person: Person } }>()
    .post("/vorschau", eingabe("json", importSchema), async (c) => {
      const person = c.get("person");
      if (!person.admin) throw new HTTPException(403);
      const { stufeId, zeilen } = c.req.valid("json");
      await pruefeStufe(person, stufeId);
      const { plan, summe } = pruefeZeilen(
        zeilen,
        await ladeBestand(db, person.abteilungId),
      );
      return c.json({ zeilen: plan.map(alsErgebnis), summe });
    })
    .post("/", eingabe("json", importSchema), async (c) => {
      const person = c.get("person");
      if (!person.admin) throw new HTTPException(403);
      const { stufeId, zeilen } = c.req.valid("json");
      await pruefeStufe(person, stufeId);
      try {
        const antwort = await db.transaction(async (tx) => {
          // Zwei gleichzeitige Importe sähen sonst beide «neu»: Der zweite wartet, liest den Bestand nach dem Commit des ersten
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`import:${person.abteilungId}`}))`,
          );
          const { plan, summe } = pruefeZeilen(
            zeilen,
            await ladeBestand(tx, person.abteilungId),
          );
          const kinder = plan.filter(
            (p) => p.status === "neu" && p.art === "kind",
          );
          if (kinder.length > 0) {
            await tx.insert(kind).values(
              kinder.map((k) => ({
                vorname: k.vorname!,
                nachname: k.nachname!,
                stufeId,
                abteilungId: person.abteilungId,
              })),
            );
          }
          // shortcut: Konten nacheinander, jedes rechnet scrypt und fragt HIBP; bei 500 Leitenden dauert das Minuten, bei einer Stufe (rund 10) Sekunden. Parallel ginge nicht in einer Transaktion.
          const leitende = [];
          for (const p of plan) {
            if (p.status !== "neu" || p.art === "kind") continue;
            const startpasswort = erzeugeStartpasswort();
            const angelegt = await legePersonAn(tx, person, c.req.raw.headers, {
              vorname: p.vorname!,
              nachname: p.nachname!,
              benutzername: p.benutzername!,
              admin: false,
              rollen: [{ stufeId, typ: p.art as "leitung" | "stufenleitung" }],
              elternteilVon: [],
              startpasswort,
            });
            leitende.push({
              name: `${p.vorname} ${p.nachname}`,
              benutzername: angelegt.benutzername,
              startpasswort,
            });
          }
          return {
            kinder: summe.kinder,
            leitende,
            uebersprungen: zeilen.length - summe.neu,
          };
        });
        // 201 erst nach dem Commit: Ein zurückgenommenes Startpasswort darf die Antwort nie erreichen
        return c.json(antwort, 201);
      } catch (fehler) {
        if (
          isAPIError(fehler) &&
          fehler.body?.code === "USERNAME_IS_ALREADY_TAKEN"
        ) {
          return c.json(
            {
              code: "BENUTZERNAME_VERGEBEN",
              message: "Dieser Benutzername ist schon vergeben.",
            },
            409,
          );
        }
        throw fehler;
      }
    });
}
