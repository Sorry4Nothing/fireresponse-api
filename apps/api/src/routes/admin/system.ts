import { monitorEventLoopDelay } from "node:perf_hooks";
import { asc, desc, eq, lt, sql as sqlText } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Sql } from "postgres";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { auditLog, bezirk, einheit, user } from "../../db/schema.js";
import { eingabe } from "../../eingabe.js";
import type { Metriken } from "../../metriken.js";
import type { Person } from "../../rechte.js";

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

// Query-Werte sind Zeichenketten
const aenderungenSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  vor: z.uuid().optional(),
});

// Nur das Kantonsadmin-Konto (die Middleware für /api/v1/admin/* verlangt zusätzlich den zweiten Faktor). Die Zahlen von /system und /requests enthalten nur Zahlen, Flags und feste Texte: keine Umgebungswerte, Hosts, Adressen, Namen oder IDs
export function erstelleSystemRouten({
  sql,
  db,
  metriken,
}: {
  sql: Sql;
  db: Db;
  metriken: Metriken;
}) {
  // Verzögerung der Ereignisschleife seit dem letzten Abruf; die Messung hält den Prozess nicht am Leben
  const schleife = monitorEventLoopDelay({ resolution: 20 });
  schleife.enable();

  return (
    new Hono<{ Variables: { person: Person } }>()
      .get("/", async (c) => {
        if (!c.get("person").kantonsadmin) throw new HTTPException(403);

        const start = performance.now();
        let erreichbar = true;
        let verbindungen: number | null = null;
        let bestand = { personen: 0, teilnehmende: 0, push: 0 };
        try {
          // Ein Aufruf: Er misst die Antwortzeit der Datenbank und zählt zugleich den Bestand
          const [z] = await sql<
            {
              personen: number;
              teilnehmende: number;
              push: number;
              verbindungen: number;
            }[]
          >`select
            (select count(*) from "user" where banned is not true)::int as personen,
            (select count(*) from teilnehmende where inaktiv_seit is null)::int as teilnehmende,
            (select count(*) from push_token)::int as push,
            (select count(*) from pg_stat_activity where datname = current_database())::int as verbindungen`;
          bestand = z;
          verbindungen = z.verbindungen;
        } catch {
          erreichbar = false;
        }
        const pingMs = Math.round(performance.now() - start);

        const speicher = process.memoryUsage();
        const commit = process.env.COMMIT_SHA;
        const antwort = c.json({
          prozess: {
            node: process.version,
            gestartetAm: new Date(Date.now() - process.uptime() * 1000),
            laufzeitSekunden: Math.round(process.uptime()),
            rssMb: mb(speicher.rss),
            heapGenutztMb: mb(speicher.heapUsed),
            heapGesamtMb: mb(speicher.heapTotal),
            // p99 seit dem letzten Abruf, in ms; null ohne Messwerte
            schleifeP99Ms:
              schleife.count > 0
                ? Math.round(schleife.percentile(99) / 1e4) / 100
                : null,
            // Nur wenn der Build sie setzt: ein Commit-Hash, nie ein beliebiger Text
            commit: commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit : null,
          },
          datenbank: {
            erreichbar,
            pingMs: erreichbar ? pingMs : null,
            verbindungen,
            poolMaximum: sql.options.max,
          },
          bestand: {
            aktivePersonen: bestand.personen,
            aktiveTeilnehmende: bestand.teilnehmende,
            pushTokens: bestand.push,
          },
          umgebung: {
            https: (process.env.BETTER_AUTH_URL ?? "").startsWith("https://"),
            produktion: process.env.NODE_ENV === "production",
          },
        });
        schleife.reset();
        return antwort;
      })
      .get("/requests", (c) => {
        if (!c.get("person").kantonsadmin) throw new HTTPException(403);
        return c.json(metriken.momentaufnahme());
      })
      // Das Protokoll der Änderungen, neueste zuerst. Es enthält IDs und feste Aktionsnamen, nie Namen oder Eingaben; die Namen der Akteure und Einheiten kommen erst beim Lesen dazu
      .get("/changes", eingabe("query", aenderungenSchema), async (c) => {
        if (!c.get("person").kantonsadmin) throw new HTTPException(403);
        const { limit, vor } = c.req.valid("query");
        const zeilen = await db
          .select({
            id: auditLog.id,
            zeit: auditLog.erstelltAm,
            aktion: auditLog.aktion,
            akteurId: auditLog.akteurId,
            akteurName: user.name,
            zielTyp: auditLog.zielTyp,
            zielId: auditLog.zielId,
            einheitId: auditLog.einheitId,
            einheitName: einheit.name,
            einheitTyp: einheit.typ,
            bezirk: bezirk.name,
            details: auditLog.details,
          })
          .from(auditLog)
          .leftJoin(user, sqlText`${user.id}::text = ${auditLog.akteurId}`)
          .leftJoin(einheit, eq(einheit.id, auditLog.einheitId))
          .leftJoin(bezirk, eq(bezirk.id, einheit.bezirkId))
          .where(vor ? lt(auditLog.id, vor) : undefined)
          .orderBy(desc(auditLog.id))
          .limit(limit + 1);
        const seite = zeilen.slice(0, limit);
        return c.json({
          eintraege: seite.map((z) => ({
            id: z.id,
            zeit: z.zeit,
            aktion: z.aktion,
            // «cli» ist die Kommandozeile ohne Konto; ein gelöschtes Konto hat keinen Namen mehr
            akteur:
              z.akteurId === "cli"
                ? { id: null, name: null, cli: true }
                : { id: z.akteurId, name: z.akteurName, cli: false },
            zielTyp: z.zielTyp,
            zielId: z.zielId,
            einheit: z.einheitId
              ? {
                  id: z.einheitId,
                  name: z.einheitName,
                  typ: z.einheitTyp,
                  bezirk: z.bezirk,
                }
              : null,
            details: z.details,
          })),
          // Die ID des letzten Eintrags, wenn es weitere gibt; als «vor» für die nächste Seite
          weiter: zeilen.length > limit ? seite[seite.length - 1].id : null,
        });
      })
      // Stand des Syncs je Einheit: nur Zeitpunkt und Fehlercode, nie der Link
      .get("/sync", async (c) => {
        if (!c.get("person").kantonsadmin) throw new HTTPException(403);
        const einheiten = await db
          .select({
            id: einheit.id,
            name: einheit.name,
            typ: einheit.typ,
            bezirk: bezirk.name,
            lodur: einheit.lodurUrlVerschluesselt,
            syncOkAm: einheit.syncOkAm,
            syncFehler: einheit.syncFehler,
          })
          .from(einheit)
          .innerJoin(bezirk, eq(bezirk.id, einheit.bezirkId))
          .orderBy(asc(bezirk.name), asc(einheit.typ));
        return c.json({
          einheiten: einheiten.map(({ lodur, ...e }) => ({
            ...e,
            lodurHinterlegt: lodur !== null,
          })),
        });
      })
  );
}
