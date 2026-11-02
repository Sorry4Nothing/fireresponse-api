import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../db/client.js";
import {
  einheit,
  einheitRolle,
  leitungAnmeldung,
  profilbild,
  programm,
  rang,
  teilnahme,
  teilnehmende,
  teilnehmendeKonto,
  user,
} from "../db/schema.js";
import { abzeichen, abzeichenFelder } from "../abzeichen.js";
import {
  ANMELDEFENSTER_STANDARD,
  anmeldungAb,
  antwortOffen,
  fensterOffen,
  schweizerDatum,
} from "../anmeldefenster.js";
import { bildUrl } from "../bild.js";
import { pushAnmeldung } from "../anmeldung-push.js";
import { eingabe } from "../eingabe.js";
import { ladeKontakt } from "../kontakt.js";
import type { Fcm } from "../push.js";
import {
  aktivesKonto,
  einheitenFuer,
  hatRolleIn,
  programmBeginn,
  programmSichtbar,
  rollenReihenfolge,
  type Person,
} from "../rechte.js";

// PostgreSQL 18 lehnt das Jahr 0000 ab (Fehler 22008), zod lässt es durch
// «offen» hat keine Zeile; die Routen füllen es mit coalesce
type Antwort = "ja" | "nein" | "offen";

const tag = z.iso.date().refine((wert) => !wert.startsWith("0000"));
const fensterSchema = z.strictObject({ von: tag, bis: tag });
const pfadSchema = z.strictObject({ id: z.uuid() });
const leitungSchema = z.strictObject({ status: z.enum(["ja", "nein"]) });
const teilnahmePfad = z.strictObject({
  id: z.uuid(),
  teilnehmendeId: z.uuid(),
});
const teilnahmeSchema = z.strictObject({ status: z.enum(["ja", "nein"]) });

// Ein Satz Felder für Liste und Detail; nie einheit_id als Eingabe, google_event_id oder google_serie. Die Anmeldung öffnet `tage` Tage vor dem Beginn; teilnahmeOffen: aktiv, nicht begonnen und im Fenster
const programmFelder = (tage: number) => ({
  id: programm.id,
  titel: programm.titel,
  status: programm.status,
  ganztaegig: programm.ganztaegig,
  beginn: programm.beginn,
  ende: programm.ende,
  tagVon: programm.tagVon,
  tagBis: programm.tagBis,
  anmeldungAb: anmeldungAb(tage),
  teilnahmeOffen: antwortOffen(tage),
  einheitId: einheit.id,
  einheitName: einheit.name,
  einheitTyp: einheit.typ,
});

type ProgrammZeile = {
  einheitId: string;
  einheitName: string;
  einheitTyp: "jf" | "kf";
};

// Die Einheit als Objekt
function ausgabe<T extends ProgrammZeile>(zeile: T) {
  const { einheitId, einheitName, einheitTyp, ...rest } = zeile;
  return {
    ...rest,
    einheit: { id: einheitId, name: einheitName, typ: einheitTyp },
  };
}

export function erstelleProgrammRouten({
  db,
  fcm,
  anmeldefensterTage = ANMELDEFENSTER_STANDARD,
}: {
  db: Db;
  fcm?: Fcm;
  anmeldefensterTage?: number;
}) {
  const felder = programmFelder(anmeldefensterTage);

  // Stand für das Antworten; die Uhr der Datenbank entscheidet, nicht JavaScript
  async function antwortStand(programmId: string) {
    const [zeile] = await db
      .select({
        begonnen: sql<boolean>`${programmBeginn} <= now()`,
        aktiv: sql<boolean>`programm.status = 'aktiv'`,
        fensterOffen: fensterOffen(anmeldefensterTage),
        ab: anmeldungAb(anmeldefensterTage),
      })
      .from(programm)
      .where(eq(programm.id, programmId));
    return zeile;
  }

  // Der Tag, an dem die Anmeldung öffnet, steht in der Meldung; eigener Code per c.json wie bei den übrigen 409
  const fensterZu = (ab: string) => ({
    code: "ANMELDEFENSTER_NICHT_OFFEN",
    message: `Die Anmeldung öffnet am ${schweizerDatum(ab)}.`,
  });

  // Nur die eigenen, aktiven Teilnehmenden der Einheit des Programms, für alle Programme in einer Abfrage
  async function eigeneTeilnehmende(person: Person, programmIds: string[]) {
    const nachProgramm = new Map<
      string,
      {
        id: string;
        vorname: string;
        status: "ja" | "nein" | null;
        abzeichen: ReturnType<typeof abzeichen>;
      }[]
    >();
    if (programmIds.length === 0) return nachProgramm;
    const zeilen = await db
      .select({
        programmId: programm.id,
        id: teilnehmende.id,
        vorname: teilnehmende.vorname,
        status: teilnahme.status,
        ...abzeichenFelder,
      })
      .from(teilnehmende)
      .innerJoin(
        teilnehmendeKonto,
        and(
          eq(teilnehmendeKonto.teilnehmendeId, teilnehmende.id),
          eq(teilnehmendeKonto.userId, person.id),
        ),
      )
      .innerJoin(
        programm,
        and(
          eq(programm.einheitId, teilnehmende.einheitId),
          inArray(programm.id, programmIds),
        ),
      )
      .leftJoin(
        teilnahme,
        and(
          eq(teilnahme.teilnehmendeId, teilnehmende.id),
          eq(teilnahme.programmId, programm.id),
        ),
      )
      .leftJoin(
        rang,
        and(
          eq(rang.id, teilnehmende.rangId),
          eq(rang.einheitId, teilnehmende.einheitId),
        ),
      )
      .where(isNull(teilnehmende.inaktivSeit))
      .orderBy(teilnehmende.vorname, teilnehmende.id);
    for (const z of zeilen) {
      const liste = nachProgramm.get(z.programmId) ?? [];
      liste.push({
        id: z.id,
        vorname: z.vorname,
        status: z.status,
        abzeichen: abzeichen(z),
      });
      nachProgramm.set(z.programmId, liste);
    }
    return nachProgramm;
  }

  // Das Programm, wenn die Person es sehen darf, sonst 404
  async function ladeSichtbar(person: Person, id: string) {
    const einheiten = await einheitenFuer(db, person, "lesen");
    const [zeile] = await db
      .select({ id: programm.id, einheitId: programm.einheitId })
      .from(programm)
      .where(and(eq(programm.id, id), programmSichtbar(einheiten)));
    if (!zeile) throw new HTTPException(404);
    return zeile;
  }

  return new Hono<{ Variables: { person: Person } }>()
    .get("/", eingabe("query", fensterSchema), async (c) => {
      const person = c.get("person");
      const { von, bis } = c.req.valid("query");
      const einheiten = await einheitenFuer(db, person, "lesen");
      const programme = await db
        .select(felder)
        .from(programm)
        .innerJoin(einheit, eq(einheit.id, programm.einheitId))
        .where(
          and(
            programmSichtbar(einheiten),
            // Inklusive Schweizer Kalendertage: Ein Lager zählt an jedem seiner Tage
            sql`coalesce(programm.tag_bis, (programm.ende at time zone 'Europe/Zurich')::date) >= ${von}`,
            sql`coalesce(programm.tag_von, (programm.beginn at time zone 'Europe/Zurich')::date) <= ${bis}`,
          ),
        )
        .orderBy(programmBeginn, programm.id);
      const eigene = await eigeneTeilnehmende(
        person,
        programme.map((p) => p.id),
      );
      return c.json({
        programme: programme.map((p) => ({
          ...ausgabe(p),
          teilnehmende: eigene.get(p.id) ?? [],
        })),
      });
    })
    .get("/:id", eingabe("param", pfadSchema), async (c) => {
      const person = c.get("person");
      const { id } = c.req.valid("param");
      const einheiten = await einheitenFuer(db, person, "lesen");
      const [zeile] = await db
        .select({
          ...felder,
          thema: programm.thema,
          info: programm.info,
          aufgebot: programm.aufgebot,
        })
        .from(programm)
        .innerJoin(einheit, eq(einheit.id, programm.einheitId))
        .where(and(eq(programm.id, id), programmSichtbar(einheiten)));
      if (!zeile) throw new HTTPException(404);
      // Nur wer sich anmelden dürfte, bekommt den Schlüssel; undefined fällt aus dem JSON, für alle anderen fehlt er
      let eigeneAnmeldung: Antwort | undefined;
      if (hatRolleIn(person, zeile.einheitId)) {
        const [anmeldung] = await db
          .select({ status: leitungAnmeldung.status })
          .from(leitungAnmeldung)
          .where(
            and(
              eq(leitungAnmeldung.programmId, id),
              eq(leitungAnmeldung.userId, person.id),
            ),
          );
        eigeneAnmeldung = anmeldung?.status ?? "offen";
      }
      const eigene = (await eigeneTeilnehmende(person, [id])).get(id) ?? [];
      return c.json({
        ...ausgabe(zeile),
        teilnehmende: eigene,
        kontakt: await ladeKontakt(db, person, zeile.einheitId, id),
        eigeneAnmeldung,
      });
    })
    .get("/:id/teilnahmen", eingabe("param", pfadSchema), async (c) => {
      const person = c.get("person");
      const { id } = c.req.valid("param");
      const { einheitId } = await ladeSichtbar(person, id);
      // Ganze Liste: das Kantonsadmin-Konto sowie Kommando und Leitende der Einheit; sonst nur die eigenen Teilnehmenden
      const gesamt = person.kantonsadmin || hatRolleIn(person, einheitId);
      const liste = await db
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
            eq(teilnehmende.einheitId, einheitId),
            isNull(teilnehmende.inaktivSeit),
            gesamt
              ? undefined
              : sql`exists (select 1 from teilnehmende_konto where teilnehmende_konto.teilnehmende_id = ${teilnehmende.id} and teilnehmende_konto.user_id = ${person.id})`,
          ),
        )
        .orderBy(
          asc(teilnehmende.vorname),
          asc(teilnehmende.nachname),
          asc(teilnehmende.id),
        );
      // Sichtbar, aber weder mit Rolle noch mit eigenen Teilnehmenden in dieser Einheit: kein Recht
      if (!gesamt && liste.length === 0) throw new HTTPException(403);
      const leitende = gesamt
        ? await db
            .select({
              id: user.id,
              name: user.name,
              bildUrl,
              rolle: einheitRolle.typ,
              status: sql<Antwort>`coalesce(${leitungAnmeldung.status}, 'offen')`,
            })
            .from(einheitRolle)
            .innerJoin(
              user,
              and(eq(user.id, einheitRolle.userId), aktivesKonto()),
            )
            .leftJoin(profilbild, eq(profilbild.userId, user.id))
            .leftJoin(
              leitungAnmeldung,
              and(
                eq(leitungAnmeldung.programmId, id),
                eq(leitungAnmeldung.userId, einheitRolle.userId),
              ),
            )
            .where(eq(einheitRolle.einheitId, einheitId))
            .orderBy(rollenReihenfolge, asc(user.name), asc(user.id))
        : [];
      const zaehle = (l: { status: Antwort }[]) => ({
        ja: l.filter((e) => e.status === "ja").length,
        nein: l.filter((e) => e.status === "nein").length,
        offen: l.filter((e) => e.status === "offen").length,
      });
      return c.json({
        zahlen: { teilnehmende: zaehle(liste), leitende: zaehle(leitende) },
        teilnehmende: liste,
        leitende,
      });
    })
    .put(
      "/:id/leitung",
      eingabe("param", pfadSchema),
      eingabe("json", leitungSchema),
      async (c) => {
        const person = c.get("person");
        const { id } = c.req.valid("param");
        const { status } = c.req.valid("json");
        const { einheitId } = await ladeSichtbar(person, id);
        if (!hatRolleIn(person, einheitId)) throw new HTTPException(403);
        const stand = await antwortStand(id);
        // Eigener Code per c.json: onError machte aus einem unbekannten HTTPException-Status den allgemeinen Text
        if (stand.begonnen) {
          return c.json(
            {
              code: "PROGRAMM_BEGONNEN",
              message: "Das Programm hat schon begonnen.",
            },
            409,
          );
        }
        if (!stand.fensterOffen) return c.json(fensterZu(stand.ab), 409);
        await db
          .insert(leitungAnmeldung)
          .values({ programmId: id, userId: person.id, status })
          .onConflictDoUpdate({
            target: [leitungAnmeldung.programmId, leitungAnmeldung.userId],
            set: { status },
          });
        return c.body(null, 204);
      },
    )
    .put(
      "/:id/teilnahmen/:teilnehmendeId",
      eingabe("param", teilnahmePfad),
      eingabe("json", teilnahmeSchema),
      async (c) => {
        const person = c.get("person");
        const { id, teilnehmendeId } = c.req.valid("param");
        const { status } = c.req.valid("json");
        // Fremde wie unbekannte Programme und Teilnehmende sind 404, auch wenn sie in derselben Einheit liegen: Es antworten nur die Eltern oder die Teilnehmenden selbst, Kommando und Leitende antworten für sich
        const { einheitId } = await ladeSichtbar(person, id);
        const [ziel] = await db
          .select({ inaktivSeit: teilnehmende.inaktivSeit })
          .from(teilnehmende)
          .innerJoin(
            teilnehmendeKonto,
            and(
              eq(teilnehmendeKonto.teilnehmendeId, teilnehmende.id),
              eq(teilnehmendeKonto.userId, person.id),
            ),
          )
          .where(
            and(
              eq(teilnehmende.id, teilnehmendeId),
              eq(teilnehmende.einheitId, einheitId),
            ),
          );
        if (!ziel) throw new HTTPException(404);
        if (ziel.inaktivSeit) throw new HTTPException(403);
        const stand = await antwortStand(id);
        if (!stand.aktiv || stand.begonnen) {
          return c.json(
            {
              code: "PROGRAMM_GESCHLOSSEN",
              message:
                "Das Programm ist abgesagt oder hat schon begonnen. Die Teilnahme lässt sich nicht mehr ändern.",
            },
            409,
          );
        }
        if (!stand.fensterOffen) return c.json(fensterZu(stand.ab), 409);
        // Ohne Zeile in returning blieb der Wert gleich: Das löst keinen Push aus
        const geaendert = await db
          .insert(teilnahme)
          .values({
            programmId: id,
            teilnehmendeId,
            status,
            geaendertVon: person.id,
          })
          .onConflictDoUpdate({
            target: [teilnahme.programmId, teilnahme.teilnehmendeId],
            set: { status, geaendertVon: person.id, geaendertAm: sql`now()` },
            setWhere: sql`${teilnahme.status} is distinct from ${status}`,
          })
          .returning({ teilnehmendeId: teilnahme.teilnehmendeId });
        if (geaendert.length > 0) {
          await pushAnmeldung(
            { db, fcm, c },
            { programmId: id, userId: person.id, status },
          );
        }
        return c.body(null, 204);
      },
    );
}
