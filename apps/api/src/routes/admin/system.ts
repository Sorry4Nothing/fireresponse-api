import { monitorEventLoopDelay } from "node:perf_hooks";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Sql } from "postgres";
import type { Metriken } from "../../metriken.js";
import type { Person } from "../../rechte.js";

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

// Nur Admins (die Middleware für /api/v1/admin/* verlangt zusätzlich den zweiten Faktor). Die Antworten enthalten nur Zahlen, Flags und feste Texte: keine Umgebungswerte, Hosts, Adressen, Namen oder IDs
export function erstelleSystemRouten({
  sql,
  metriken,
}: {
  sql: Sql;
  metriken: Metriken;
}) {
  // Verzögerung der Ereignisschleife seit dem letzten Abruf; die Messung hält den Prozess nicht am Leben
  const schleife = monitorEventLoopDelay({ resolution: 20 });
  schleife.enable();

  return new Hono<{ Variables: { person: Person } }>()
    .get("/", async (c) => {
      const person = c.get("person");
      if (!person.admin) throw new HTTPException(403);

      const start = performance.now();
      let erreichbar = true;
      let verbindungen: number | null = null;
      let bestand = { personen: 0, kinder: 0, push: 0 };
      try {
        // Ein Aufruf: Er misst die Antwortzeit der Datenbank und zählt zugleich den Bestand der Abteilung
        const [z] = await sql<
          {
            personen: number;
            kinder: number;
            push: number;
            verbindungen: number;
          }[]
        >`select
            (select count(*) from "user" where abteilung_id = ${person.abteilungId} and banned is not true)::int as personen,
            (select count(*) from kind where abteilung_id = ${person.abteilungId} and inaktiv_seit is null)::int as kinder,
            (select count(*) from push_token p join "user" u on u.id = p.user_id where u.abteilung_id = ${person.abteilungId})::int as push,
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
          aktiveKinder: bestand.kinder,
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
      if (!c.get("person").admin) throw new HTTPException(403);
      return c.json(metriken.momentaufnahme());
    });
}
