import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { auditLog, einheit, programm } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import type { Fcm } from "../../push.js";
import { pruefeEinheit, programmBeginn, type Person } from "../../rechte.js";
import {
  ladePushZeile,
  sendeAbsagePush,
  sendeAenderungsPush,
} from "../../termin-push.js";

// PostgreSQL 18 lehnt das Jahr 0000 ab (Fehler 22008), zod lässt es durch
const tag = z.iso.date().refine((wert) => !wert.startsWith("0000"));
// Schweizer Wanduhrzeit «2031-06-10T18:30» ohne Zone: Der Server rechnet sie mit Europe/Zurich um, nie der Browser
const wanduhr = z.iso
  .datetime({ local: true, precision: -1 })
  .refine((wert) => !wert.startsWith("0000") && !wert.endsWith("Z"));
const fensterSchema = z.strictObject({ von: tag, bis: tag });
const einheitPfad = z.strictObject({ einheitId: z.uuid() });
const terminPfad = z.strictObject({ einheitId: z.uuid(), id: z.uuid() });

const titel = z.string().trim().min(1).max(120);
const kurz = z.string().trim().min(1).max(120).nullable();
const lang = z.string().trim().min(1).max(2000).nullable();

type Zeit = {
  ganztaegig?: boolean;
  beginn?: string;
  ende?: string;
  tagVon?: string;
  tagBis?: string;
};
// Ganztägig braucht beide Tage (der zweite nicht vor dem ersten), sonst Beginn und Ende (Ende nach Beginn); nie beides. Ohne ganztaegig darf keine Zeitangabe da sein
function zeitPasst(d: Zeit) {
  if (d.ganztaegig === undefined) {
    return !d.beginn && !d.ende && !d.tagVon && !d.tagBis;
  }
  return d.ganztaegig
    ? !!d.tagVon && !!d.tagBis && d.tagVon <= d.tagBis && !d.beginn && !d.ende
    : !!d.beginn && !!d.ende && d.beginn < d.ende && !d.tagVon && !d.tagBis;
}

const zeitFelder = {
  beginn: wanduhr.optional(),
  ende: wanduhr.optional(),
  tagVon: tag.optional(),
  tagBis: tag.optional(),
};
const textFelder = {
  art: kurz.optional(),
  ort: kurz.optional(),
  thema: lang.optional(),
  info: lang.optional(),
  aufgebot: lang.optional(),
};
// Quelle, Status und id nimmt keine Eingabe an: Das strikte Schema lehnt sie ab
const anlegenSchema = z
  .strictObject({
    titel,
    ganztaegig: z.boolean(),
    ...zeitFelder,
    ...textFelder,
    nurLeitende: z.boolean().optional(),
  })
  .refine(zeitPasst);
// Bei Terminen aus Lodur gilt nur nurLeitende; die Route lehnt jedes andere Feld mit 409 ab
const aendernSchema = z
  .strictObject({
    titel: titel.optional(),
    ganztaegig: z.boolean().optional(),
    ...zeitFelder,
    ...textFelder,
    nurLeitende: z.boolean().optional(),
  })
  .refine((d) => Object.values(d).some((wert) => wert !== undefined))
  .refine(zeitPasst);

const nachZuerich = (wert: string) =>
  sql`${wert}::timestamp at time zone 'Europe/Zurich'`;

// Was die Verwaltung von einem Termin sieht; googleOrt heisst in der Datenbank noch so (Spalte aus der Planung vor Lodur)
const terminSpalten = {
  id: programm.id,
  titel: programm.titel,
  art: programm.art,
  status: programm.status,
  quelle: programm.quelle,
  ganztaegig: programm.ganztaegig,
  beginn: programm.beginn,
  ende: programm.ende,
  tagVon: programm.tagVon,
  tagBis: programm.tagBis,
  ort: programm.googleOrt,
  thema: programm.thema,
  info: programm.info,
  aufgebot: programm.aufgebot,
  nurLeitende: programm.nurLeitende,
};
// Diese Felder zeigen die Apps; ändert sich eines, bekommen die Angemeldeten einen Push. Der Ort (noch nicht in den Apps) und der Schalter lösen keinen aus
const FUER_PUSH = [
  "titel",
  "art",
  "thema",
  "info",
  "aufgebot",
  "ganztaegig",
  "beginn",
  "ende",
  "tagVon",
  "tagBis",
] as const;

const AUS_LODUR = {
  code: "TERMIN_AUS_LODUR",
  message: "Dieser Termin kommt aus Lodur und lässt sich hier nicht ändern.",
} as const;
const LINK_GESETZT = {
  code: "LODUR_LINK_GESETZT",
  message:
    "Die Einheit holt ihre Termine aus Lodur. Eigene Termine gibt es erst, wenn der Link entfernt ist.",
} as const;

// Die Termine einer Einheit für die Verwaltung. Titel, Zeit und Texte der Termine aus Lodur gehören dem Sync und sind hier nur zu sehen; der Schalter «nur Leitende» gehört der Verwaltung, der Sync überschreibt ihn nie. Termine der Quelle «manuell» legt, ändert und löscht die Verwaltung, der Sync fasst sie nie an. Wer darf, regelt pruefeEinheit «verwalten»: Kommando, Stellvertretung und Kantonsadmin
export function erstelleTermineRouten({ db, fcm }: { db: Db; fcm?: Fcm }) {
  // Der Push läuft nach dem Speichern und wirft nie
  const umgebung = (c: Context) => ({ db, fcm, c });

  return new Hono<{ Variables: { person: Person } }>()
    .get(
      "/",
      eingabe("param", einheitPfad),
      eingabe("query", fensterSchema),
      async (c) => {
        const { einheitId } = c.req.valid("param");
        const { von, bis } = c.req.valid("query");
        await pruefeEinheit(db, c.get("person"), einheitId, "verwalten");
        const termine = await db
          .select(terminSpalten)
          .from(programm)
          .where(
            and(
              eq(programm.einheitId, einheitId),
              // Inklusive Schweizer Kalendertage: Ein Lager zählt an jedem seiner Tage
              sql`coalesce(programm.tag_bis, (programm.ende at time zone 'Europe/Zurich')::date) >= ${von}`,
              sql`coalesce(programm.tag_von, (programm.beginn at time zone 'Europe/Zurich')::date) <= ${bis}`,
            ),
          )
          .orderBy(programmBeginn, programm.id);
        return c.json({ termine });
      },
    )
    .post(
      "/",
      eingabe("param", einheitPfad),
      eingabe("json", anlegenSchema),
      async (c) => {
        const person = c.get("person");
        const { einheitId } = c.req.valid("param");
        const d = c.req.valid("json");
        await pruefeEinheit(db, person, einheitId, "verwalten");
        const termin = await db.transaction(async (tx) => {
          // Mit Sperre auf der Einheit: Ein gleichzeitig gesetzter Lodur-Link und der neue Termin schliessen sich aus
          const [e] = await tx
            .select({ lodur: einheit.lodurUrlVerschluesselt })
            .from(einheit)
            .where(eq(einheit.id, einheitId))
            .for("share");
          if (!e) throw new HTTPException(404);
          if (e.lodur !== null) return null;
          const [neu] = await tx
            .insert(programm)
            .values({
              einheitId,
              quelle: "manuell",
              // Die Spalte ist je Einheit eindeutig und sonst für Lodur-UIDs da
              googleEventId: `manuell-${randomUUID()}`,
              titel: d.titel,
              ganztaegig: d.ganztaegig,
              beginn: d.beginn ? nachZuerich(d.beginn) : null,
              ende: d.ende ? nachZuerich(d.ende) : null,
              tagVon: d.tagVon ?? null,
              tagBis: d.tagBis ?? null,
              art: d.art ?? null,
              googleOrt: d.ort ?? null,
              thema: d.thema ?? null,
              info: d.info ?? null,
              aufgebot: d.aufgebot ?? null,
              nurLeitende: d.nurLeitende ?? false,
            })
            .returning(terminSpalten);
          await tx.insert(auditLog).values({
            einheitId,
            akteurId: person.id,
            aktion: "termin_angelegt",
            zielTyp: "programm",
            zielId: neu!.id,
            // Ohne Titel und Texte: Das Log trägt keine Inhalte
            details: { nurLeitende: neu!.nurLeitende },
          });
          return neu!;
        });
        if (!termin) return c.json(LINK_GESETZT, 409);
        return c.json(termin, 201);
      },
    )
    .put(
      "/:id",
      eingabe("param", terminPfad),
      eingabe("json", aendernSchema),
      async (c) => {
        const person = c.get("person");
        const { einheitId, id } = c.req.valid("param");
        const { nurLeitende, ...inhalt } = c.req.valid("json");
        const felder = Object.keys(inhalt).filter(
          (f) => inhalt[f as keyof typeof inhalt] !== undefined,
        );
        await pruefeEinheit(db, person, einheitId, "verwalten");
        const ergebnis = await db.transaction(async (tx) => {
          // In SQL auf die Einheit gefiltert: Termine einer anderen Einheit sind 404
          const [alt] = await tx
            .select(terminSpalten)
            .from(programm)
            .where(and(eq(programm.id, id), eq(programm.einheitId, einheitId)))
            .for("update");
          if (!alt) throw new HTTPException(404);
          if (alt.quelle !== "manuell" && felder.length > 0) return "lodur";
          const d = inhalt;
          const aenderung = {
            ...(d.titel !== undefined && { titel: d.titel }),
            ...(d.ganztaegig !== undefined && {
              ganztaegig: d.ganztaegig,
              beginn: d.beginn ? nachZuerich(d.beginn) : null,
              ende: d.ende ? nachZuerich(d.ende) : null,
              tagVon: d.tagVon ?? null,
              tagBis: d.tagBis ?? null,
            }),
            ...(d.art !== undefined && { art: d.art }),
            ...(d.ort !== undefined && { googleOrt: d.ort }),
            ...(d.thema !== undefined && { thema: d.thema }),
            ...(d.info !== undefined && { info: d.info }),
            ...(d.aufgebot !== undefined && { aufgebot: d.aufgebot }),
            ...(nurLeitende !== undefined &&
              nurLeitende !== alt.nurLeitende && { nurLeitende }),
          };
          if (Object.keys(aenderung).length === 0) {
            return { termin: alt, push: false };
          }
          const [neu] = await tx
            .update(programm)
            .set(aenderung)
            .where(eq(programm.id, id))
            .returning(terminSpalten);
          if (neu!.nurLeitende !== alt.nurLeitende) {
            await tx.insert(auditLog).values({
              einheitId,
              akteurId: person.id,
              aktion: "termin_sichtbarkeit_geaendert",
              zielTyp: "programm",
              zielId: id,
              details: { nurLeitende: neu!.nurLeitende },
            });
          }
          if (felder.length > 0) {
            await tx.insert(auditLog).values({
              einheitId,
              akteurId: person.id,
              aktion: "termin_geaendert",
              zielTyp: "programm",
              zielId: id,
              // Nur die Namen der Felder, nie ihr Inhalt
              details: { felder },
            });
          }
          const wert = (t: typeof alt) =>
            JSON.stringify(FUER_PUSH.map((f) => t[f]));
          return {
            termin: neu!,
            push: neu!.status === "aktiv" && wert(neu!) !== wert(alt),
          };
        });
        if (ergebnis === "lodur") return c.json(AUS_LODUR, 409);
        if (ergebnis.push) await sendeAenderungsPush(umgebung(c), id);
        return c.json(ergebnis.termin);
      },
    )
    .delete("/:id", eingabe("param", terminPfad), async (c) => {
      const person = c.get("person");
      const { einheitId, id } = c.req.valid("param");
      await pruefeEinheit(db, person, einheitId, "verwalten");
      // Titel und Beginn für den Push, solange die Zeile noch da ist
      const pushZeile = await ladePushZeile(umgebung(c), id);
      const ergebnis = await db.transaction(async (tx) => {
        const [alt] = await tx
          .select({ quelle: programm.quelle, status: programm.status })
          .from(programm)
          .where(and(eq(programm.id, id), eq(programm.einheitId, einheitId)))
          .for("update");
        if (!alt) throw new HTTPException(404);
        if (alt.quelle !== "manuell") return null;
        await tx.delete(programm).where(eq(programm.id, id));
        await tx.insert(auditLog).values({
          einheitId,
          akteurId: person.id,
          aktion: "termin_geloescht",
          zielTyp: "programm",
          zielId: id,
        });
        return alt;
      });
      if (!ergebnis) return c.json(AUS_LODUR, 409);
      // Abgesagte Termine sind schon gemeldet; für begonnene gibt es keine Zeile
      if (ergebnis.status === "aktiv" && pushZeile) {
        await sendeAbsagePush(umgebung(c), id, pushZeile);
      }
      return c.body(null, 204);
    });
}
