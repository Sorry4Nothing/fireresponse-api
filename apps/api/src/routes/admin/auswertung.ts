import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  jahresuebersicht,
  mitQuote,
  programmeIn,
  quotenLeitende,
  quotenTeilnehmende,
  type Bereich,
  type Zahlen,
} from "../../auswertung.js";
import type { Db } from "../../db/client.js";
import {
  bezirk,
  einheit,
  einheitRolle,
  leitungAnmeldung,
  programm,
  teilnahme,
  teilnehmende,
  user,
} from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import { adminLogoUrl } from "../../einheiten.js";
import {
  aktivesKonto,
  einheitenFuer,
  hatVerwaltung,
  pruefeEinheit,
  programmBeginn,
  programmSichtbar,
  rollenReihenfolge,
  type Person,
} from "../../rechte.js";

// Nur Kommando und Stellvertretungen (zweck «verwalten») sowie das Kantonsadmin-Konto. Alle Routen sind lesend, zählen Anmeldungen und liefern nie Konten, Telefonnummern, Bilder oder Eltern; einen Export gibt es nicht

// PostgreSQL 18 lehnt das Jahr 0000 ab (Fehler 22008), zod lässt es durch
const tag = z.iso.date().refine((wert) => !wert.startsWith("0000"));
const TAGE_MAX = 366;
const tageZwischen = (von: string, bis: string) =>
  (Date.parse(bis) - Date.parse(von)) / 86_400_000;

const filter = {
  bezirkId: z.uuid().optional(),
  einheitId: z.uuid().optional(),
  rolle: z.enum(["teilnehmende", "leitende"]).optional(),
};
// Höchstens ein Jahr am Stück: Die Antwort wächst mit Zeitraum und Einheiten, ohne Grenze liesse sie sich beliebig gross anfordern
const zeitraum = {
  von: tag,
  bis: tag,
};
const imRahmen = (w: { von: string; bis: string }) =>
  w.von <= w.bis && tageZwischen(w.von, w.bis) <= TAGE_MAX;
const zeitraumSchema = z
  .strictObject({ ...zeitraum, ...filter })
  .refine(imRahmen);
const termineSchema = zeitraumSchema;
const nurZeitraum = z.strictObject(zeitraum).refine(imRahmen);
const jahrSchema = z.strictObject({
  jahr: z.coerce.number().int().min(2000).max(2100),
  ...filter,
});
const termin = z.strictObject({ id: z.uuid() });
const personPfad = z.strictObject({ einheitId: z.uuid(), id: z.uuid() });

type Antwort = "ja" | "nein" | "offen";

export function erstelleAuswertungRouten({ db }: { db: Db }) {
  // Einheiten, die diese Anfrage auswerten darf. Wer nichts verwalten darf, bekommt 403; eine genannte Einheit, die er nicht kennt, 404
  async function bereichFuer(
    person: Person,
    q: { von: string; bis: string; bezirkId?: string; einheitId?: string },
  ): Promise<Bereich> {
    if (!person.kantonsadmin && !hatVerwaltung(person)) {
      throw new HTTPException(403);
    }
    if (q.einheitId !== undefined) {
      await pruefeEinheit(db, person, q.einheitId, "verwalten");
    }
    return {
      einheiten:
        q.einheitId === undefined
          ? await einheitenFuer(db, person, "verwalten")
          : [q.einheitId],
      bezirkId: q.bezirkId,
      von: q.von,
      bis: q.bis,
    };
  }

  return new Hono<{ Variables: { person: Person } }>()
    .get("/filter", async (c) => {
      const person = c.get("person");
      if (!person.kantonsadmin && !hatVerwaltung(person)) {
        throw new HTTPException(403);
      }
      const einheiten = await db
        .select({
          id: einheit.id,
          name: einheit.name,
          typ: einheit.typ,
          bezirkId: bezirk.id,
          bezirkName: bezirk.name,
          logoUrl: adminLogoUrl,
        })
        .from(einheit)
        .innerJoin(bezirk, eq(bezirk.id, einheit.bezirkId))
        .where(
          inArray(einheit.id, await einheitenFuer(db, person, "verwalten")),
        )
        .orderBy(asc(bezirk.name), asc(einheit.typ), asc(einheit.name));
      const bezirke = new Map(einheiten.map((e) => [e.bezirkId, e.bezirkName]));
      return c.json({
        // Das Kantonsadmin-Konto sieht alle Bezirke und Einheiten und schaltet zwischen ihnen um; das Kommando hat nur die eigenen
        umschalter: person.kantonsadmin,
        bezirke: [...bezirke].map(([id, name]) => ({ id, name })),
        einheiten: einheiten.map((e) => ({
          id: e.id,
          name: e.name,
          typ: e.typ,
          bezirkId: e.bezirkId,
          logoUrl: e.logoUrl,
        })),
      });
    })
    .get("/termine", eingabe("query", termineSchema), async (c) => {
      const q = c.req.valid("query");
      const b = await bereichFuer(c.get("person"), q);
      const teilnahmen = (status: Antwort) =>
        sql<number>`(select count(*) from ${teilnahme} join ${teilnehmende} on ${teilnehmende.id} = ${teilnahme.teilnehmendeId} where ${teilnahme.programmId} = ${programm.id} and ${teilnehmende.inaktivSeit} is null and ${teilnahme.status} = ${status})::int`;
      const leitung = (status: Antwort) =>
        sql<number>`(select count(*) from ${leitungAnmeldung} join ${einheitRolle} on ${einheitRolle.userId} = ${leitungAnmeldung.userId} and ${einheitRolle.einheitId} = ${programm.einheitId} join ${user} on ${user.id} = ${leitungAnmeldung.userId} where ${leitungAnmeldung.programmId} = ${programm.id} and ${aktivesKonto()} and ${leitungAnmeldung.status} = ${status})::int`;
      const zeilen = await db
        .select({
          id: programm.id,
          titel: programm.titel,
          status: programm.status,
          ganztaegig: programm.ganztaegig,
          beginn: programm.beginn,
          ende: programm.ende,
          tagVon: programm.tagVon,
          tagBis: programm.tagBis,
          begonnen: sql<boolean>`${programmBeginn} <= now()`,
          einheitId: einheit.id,
          einheitName: einheit.name,
          einheitTyp: einheit.typ,
          teilnehmendeGesamt: sql<number>`(select count(*) from ${teilnehmende} where ${teilnehmende.einheitId} = ${programm.einheitId} and ${teilnehmende.inaktivSeit} is null)::int`,
          teilnehmendeJa: teilnahmen("ja"),
          teilnehmendeNein: teilnahmen("nein"),
          leitendeGesamt: sql<number>`(select count(*) from ${einheitRolle} join ${user} on ${user.id} = ${einheitRolle.userId} where ${einheitRolle.einheitId} = ${programm.einheitId} and ${aktivesKonto()})::int`,
          leitendeJa: leitung("ja"),
          leitendeNein: leitung("nein"),
        })
        .from(programm)
        .innerJoin(einheit, eq(einheit.id, programm.einheitId))
        .where(programmeIn(b, false))
        .orderBy(programmBeginn, programm.id);
      const zahlen = (gesamt: number, ja: number, nein: number) =>
        mitQuote({ ja, nein, offen: gesamt - ja - nein });
      return c.json({
        termine: zeilen.map((z) => ({
          id: z.id,
          titel: z.titel,
          status: z.status,
          ganztaegig: z.ganztaegig,
          beginn: z.beginn,
          ende: z.ende,
          tagVon: z.tagVon,
          tagBis: z.tagBis,
          begonnen: z.begonnen,
          einheit: { id: z.einheitId, name: z.einheitName, typ: z.einheitTyp },
          teilnehmende:
            q.rolle === "leitende"
              ? null
              : zahlen(
                  z.teilnehmendeGesamt,
                  z.teilnehmendeJa,
                  z.teilnehmendeNein,
                ),
          leitende:
            q.rolle === "teilnehmende"
              ? null
              : zahlen(z.leitendeGesamt, z.leitendeJa, z.leitendeNein),
        })),
      });
    })
    .get("/termine/:id", eingabe("param", termin), async (c) => {
      const person = c.get("person");
      const { id } = c.req.valid("param");
      // Erst sichtbar (404), dann das Recht der Einheit (403)
      const [zeile] = await db
        .select({
          id: programm.id,
          titel: programm.titel,
          status: programm.status,
          ganztaegig: programm.ganztaegig,
          beginn: programm.beginn,
          ende: programm.ende,
          tagVon: programm.tagVon,
          tagBis: programm.tagBis,
          begonnen: sql<boolean>`${programmBeginn} <= now()`,
          einheitId: einheit.id,
          einheitName: einheit.name,
          einheitTyp: einheit.typ,
        })
        .from(programm)
        .innerJoin(einheit, eq(einheit.id, programm.einheitId))
        .where(
          and(
            eq(programm.id, id),
            programmSichtbar(await einheitenFuer(db, person, "lesen")),
          ),
        );
      if (!zeile) throw new HTTPException(404);
      await pruefeEinheit(db, person, zeile.einheitId, "verwalten");

      const [teilnehmendeListe, leitende] = await Promise.all([
        db
          .select({
            id: teilnehmende.id,
            vorname: teilnehmende.vorname,
            nachname: teilnehmende.nachname,
            status: sql<Antwort>`coalesce(${teilnahme.status}, 'offen')`,
          })
          .from(teilnehmende)
          .leftJoin(
            teilnahme,
            and(
              eq(teilnahme.teilnehmendeId, teilnehmende.id),
              eq(teilnahme.programmId, id),
            ),
          )
          .where(
            and(
              eq(teilnehmende.einheitId, zeile.einheitId),
              isNull(teilnehmende.inaktivSeit),
            ),
          )
          .orderBy(
            asc(teilnehmende.nachname),
            asc(teilnehmende.vorname),
            asc(teilnehmende.id),
          ),
        db
          .select({
            id: user.id,
            name: user.name,
            rolle: einheitRolle.typ,
            status: sql<Antwort>`coalesce(${leitungAnmeldung.status}, 'offen')`,
          })
          .from(einheitRolle)
          .innerJoin(
            user,
            and(eq(user.id, einheitRolle.userId), aktivesKonto()),
          )
          .leftJoin(
            leitungAnmeldung,
            and(
              eq(leitungAnmeldung.programmId, id),
              eq(leitungAnmeldung.userId, einheitRolle.userId),
            ),
          )
          .where(eq(einheitRolle.einheitId, zeile.einheitId))
          .orderBy(rollenReihenfolge, asc(user.name), asc(user.id)),
      ]);
      const zaehle = (l: { status: Antwort }[]) =>
        mitQuote({
          ja: l.filter((e) => e.status === "ja").length,
          nein: l.filter((e) => e.status === "nein").length,
          offen: l.filter((e) => e.status === "offen").length,
        });
      return c.json({
        termin: {
          id: zeile.id,
          titel: zeile.titel,
          status: zeile.status,
          ganztaegig: zeile.ganztaegig,
          beginn: zeile.beginn,
          ende: zeile.ende,
          tagVon: zeile.tagVon,
          tagBis: zeile.tagBis,
          begonnen: zeile.begonnen,
          einheit: {
            id: zeile.einheitId,
            name: zeile.einheitName,
            typ: zeile.einheitTyp,
          },
        },
        zahlen: {
          teilnehmende: zaehle(teilnehmendeListe),
          leitende: zaehle(leitende),
        },
        teilnehmende: teilnehmendeListe,
        leitende,
      });
    })
    .get("/quoten", eingabe("query", zeitraumSchema), async (c) => {
      const q = c.req.valid("query");
      const b = await bereichFuer(c.get("person"), q);
      const [tn, le] = await Promise.all([
        q.rolle === "leitende" ? [] : quotenTeilnehmende(db, b),
        q.rolle === "teilnehmende" ? [] : quotenLeitende(db, b),
      ]);
      return c.json({ von: q.von, bis: q.bis, personen: [...tn, ...le] });
    })
    .get("/jahr", eingabe("query", jahrSchema), async (c) => {
      const q = c.req.valid("query");
      const b = await bereichFuer(c.get("person"), {
        von: `${q.jahr}-01-01`,
        bis: `${q.jahr}-12-31`,
        bezirkId: q.bezirkId,
        einheitId: q.einheitId,
      });
      return c.json({
        jahr: q.jahr,
        einheiten: await jahresuebersicht(db, b, q.rolle),
      });
    })
    .get(
      "/einheiten/:einheitId/teilnehmende/:id",
      eingabe("param", personPfad),
      eingabe("query", nurZeitraum),
      async (c) => {
        const { einheitId, id } = c.req.valid("param");
        const { von, bis } = c.req.valid("query");
        await pruefeEinheit(db, c.get("person"), einheitId, "verwalten");
        const b: Bereich = { einheiten: [einheitId], von, bis };
        const [p] = await db
          .select({
            vorname: teilnehmende.vorname,
            nachname: teilnehmende.nachname,
            einheitName: einheit.name,
            einheitTyp: einheit.typ,
          })
          .from(teilnehmende)
          .innerJoin(einheit, eq(einheit.id, teilnehmende.einheitId))
          .where(
            and(
              eq(teilnehmende.id, id),
              eq(teilnehmende.einheitId, einheitId),
              isNull(teilnehmende.inaktivSeit),
            ),
          );
        if (!p) throw new HTTPException(404);
        const termine = await db
          .select({
            id: programm.id,
            titel: programm.titel,
            ganztaegig: programm.ganztaegig,
            beginn: programm.beginn,
            tagVon: programm.tagVon,
            antwort: sql<Antwort>`coalesce(${teilnahme.status}, 'offen')`,
          })
          .from(programm)
          .innerJoin(einheit, eq(einheit.id, programm.einheitId))
          .leftJoin(
            teilnahme,
            and(
              eq(teilnahme.programmId, programm.id),
              eq(teilnahme.teilnehmendeId, id),
            ),
          )
          .where(programmeIn(b, true))
          .orderBy(programmBeginn, programm.id);
        return c.json({
          person: {
            id,
            name: `${p.vorname} ${p.nachname}`,
            art: "teilnehmende" as const,
            rolle: null,
            einheit: { id: einheitId, name: p.einheitName, typ: p.einheitTyp },
          },
          von,
          bis,
          zahlen: {
            termine: termine.length,
            ...mitQuote(zaehleAntworten(termine)),
          },
          termine,
        });
      },
    )
    .get(
      "/einheiten/:einheitId/leitende/:id",
      eingabe("param", personPfad),
      eingabe("query", nurZeitraum),
      async (c) => {
        const { einheitId, id } = c.req.valid("param");
        const { von, bis } = c.req.valid("query");
        await pruefeEinheit(db, c.get("person"), einheitId, "verwalten");
        const b: Bereich = { einheiten: [einheitId], von, bis };
        const [p] = await db
          .select({
            name: user.name,
            rolle: einheitRolle.typ,
            einheitName: einheit.name,
            einheitTyp: einheit.typ,
          })
          .from(einheitRolle)
          .innerJoin(einheit, eq(einheit.id, einheitRolle.einheitId))
          .innerJoin(
            user,
            and(eq(user.id, einheitRolle.userId), aktivesKonto()),
          )
          .where(
            and(
              eq(einheitRolle.userId, id),
              eq(einheitRolle.einheitId, einheitId),
            ),
          );
        if (!p) throw new HTTPException(404);
        const termine = await db
          .select({
            id: programm.id,
            titel: programm.titel,
            ganztaegig: programm.ganztaegig,
            beginn: programm.beginn,
            tagVon: programm.tagVon,
            antwort: sql<Antwort>`coalesce(${leitungAnmeldung.status}, 'offen')`,
          })
          .from(programm)
          .innerJoin(einheit, eq(einheit.id, programm.einheitId))
          .leftJoin(
            leitungAnmeldung,
            and(
              eq(leitungAnmeldung.programmId, programm.id),
              eq(leitungAnmeldung.userId, id),
            ),
          )
          .where(programmeIn(b, true))
          .orderBy(programmBeginn, programm.id);
        return c.json({
          person: {
            id,
            name: p.name,
            art: "leitende" as const,
            rolle: p.rolle,
            einheit: { id: einheitId, name: p.einheitName, typ: p.einheitTyp },
          },
          von,
          bis,
          zahlen: {
            termine: termine.length,
            ...mitQuote(zaehleAntworten(termine)),
          },
          termine,
        });
      },
    );
}

function zaehleAntworten(l: { antwort: Antwort }[]): Zahlen {
  return {
    ja: l.filter((e) => e.antwort === "ja").length,
    nein: l.filter((e) => e.antwort === "nein").length,
    offen: l.filter((e) => e.antwort === "offen").length,
  };
}
