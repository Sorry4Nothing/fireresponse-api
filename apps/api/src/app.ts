import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { routePath } from "hono/route";
import type { Sql } from "postgres";
import { erstelleAdminSeiten, type AdminDateien } from "./admin-seiten.js";
import type { BildKodierer } from "./bild.js";
import { erstelleAuthRouten, type erstelleAuth } from "./auth.js";
import type { Db } from "./db/client.js";
import { log } from "./log.js";
import type { Fcm } from "./push.js";
import { erstelleMetriken } from "./metriken.js";
import { personAusSitzung, zweiterFaktorPflicht } from "./rechte.js";
import { erstelleEinheitenRouten } from "./routes/admin/einheiten.js";
import { erstelleLodurRouten } from "./routes/admin/lodur.js";
import { erstelleSystemRouten } from "./routes/admin/system.js";
import { erstelleZeitregelRouten } from "./routes/admin/zeitregeln.js";
import { erstelleEinwilligungRouten } from "./routes/einwilligung.js";
import { erstelleIchRouten } from "./routes/ich.js";
import { erstelleProfilbildRouten } from "./routes/profilbild.js";
import { erstelleProgrammRouten } from "./routes/programme.js";
import { erstellePushTokenRouten } from "./routes/push-token.js";

// Ein Format für alle Fehler, wie bei better-auth, damit die App nur eines kennen muss
const FEHLER: Record<number, { code: string; message: string }> = {
  400: { code: "UNGUELTIGE_EINGABE", message: "Ungültige Eingabe" },
  401: { code: "NICHT_ANGEMELDET", message: "Nicht angemeldet" },
  403: { code: "KEINE_BERECHTIGUNG", message: "Keine Berechtigung" },
  404: { code: "NICHT_GEFUNDEN", message: "Nicht gefunden" },
  413: { code: "ZU_GROSS", message: "Anfrage zu gross" },
  429: { code: "ZU_VIELE_ANFRAGEN", message: "Zu viele Anfragen" },
  426: { code: "APP_VERALTET", message: "Bitte App aktualisieren" },
  500: { code: "INTERNER_FEHLER", message: "Interner Fehler" },
};

// An jeder Antwort (#220); die Verwaltung setzt eine volle CSP selbst, die behält sie
const SICHERHEITS_KOPFZEILEN = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

// Lesende Methoden ändern nichts; der Origin zählt nur bei den übrigen (#221)
const LESEND = new Set(["GET", "HEAD", "OPTIONS"]);

// Drei Zahlen statt semver: Die App schickt ihre Version als x.y.z
function istVeraltet(version: string, minimum: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return true;
  const [a, b] = [version, minimum].map((v) => v.split(".").map(Number));
  const i = a.findIndex((zahl, j) => zahl !== b[j]);
  return i !== -1 && a[i] < b[i];
}

// Auch in den Importen ohne node:* und process: Die App prüft diese Datei über AppType ohne die Typen von Node, die Konfiguration kommt als Parameter
export function erstelleApp({
  appMinVersion,
  sql,
  db,
  auth,
  fcm,
  kodiereBild,
  seiten,
  lodurErlaubteHosts = [],
}: {
  appMinVersion: string;
  sql: Sql;
  db: Db;
  auth: ReturnType<typeof erstelleAuth>;
  fcm?: Fcm;
  // sharp steckt in bild-sharp.ts: Schon ein Import zöge dessen Typen von Node in dieses Programm; ohne Kodierer antwortet der Upload mit 501
  kodiereBild?: BildKodierer;
  // Ausgeschrieben statt aus seiten.ts importiert: Schon ein Typ-Import zöge node:fs in dieses Programm
  seiten: {
    admin: AdminDateien;
    datenschutz: string;
    kontoLoeschen: string;
    support: string;
  };
  // Hosts, die ein Lodur-Link haben darf (LODUR_ERLAUBTE_HOSTS); leer heisst: kein Link möglich
  lodurErlaubteHosts?: readonly string[];
}) {
  // Zahlen der laufenden Instanz; nach einem Neustart leer
  const metriken = erstelleMetriken();
  const kleinesLimit = bodyLimit({ maxSize: 64 * 1024 });
  return (
    // nutzerId setzt personAusSitzung, sobald es die Sitzung gelesen hat
    new Hono<{ Variables: { nutzerId?: string } }>()
      // Ohne Header-Name übernimmt Hono keine ID vom Client und schickt keine zurück
      .use(requestId({ headerName: "" }))
      .use(async (c, next) => {
        await next();
        for (const [kopf, wert] of Object.entries(SICHERHEITS_KOPFZEILEN)) {
          if (!c.res.headers.has(kopf)) c.header(kopf, wert);
        }
        // Nur JSON: Bilder und Seiten behalten ihre eigenen Cache-Regeln
        if (
          !c.res.headers.has("Cache-Control") &&
          c.res.headers.get("Content-Type")?.startsWith("application/json")
        ) {
          c.header("Cache-Control", "no-store");
        }
      })
      .use(async (c, next) => {
        const start = performance.now();
        await next();
        // Das Muster der Route statt des Pfads: Pfad und Query können Tokens enthalten
        const eintrag = {
          methode: c.req.method,
          route: routePath(c, -1),
          status: c.res.status,
          dauerMs: Math.round(performance.now() - start),
        };
        // Der Healthcheck von Docker fragt alle 30 s; ein Erfolg füllt weder Log noch Zahlen, ein Fehler bleibt sichtbar (die requestId verbindet ihn mit seinem Grund)
        if (eintrag.route === "/health" && eintrag.status === 200) return;
        const nutzerId = c.get("nutzerId");
        // Den Akteur nur bei 401 und 403 (#224): die ID, kein Name
        log(c, {
          ...eintrag,
          ...((eintrag.status === 401 || eintrag.status === 403) &&
            nutzerId !== undefined && { nutzerId }),
        });
        // Nicht gezählt: die statischen Dateien der Verwaltung und die Abrufe der Übersicht selbst, sonst misst sich die Übersicht ständig selbst
        if (
          !eintrag.route.startsWith("/admin") &&
          !eintrag.route.startsWith("/api/v1/admin/system")
        ) {
          metriken.erfasse(eintrag);
        }
      })
      // Ausnahme: der Upload des Profilbilds, den die Route selbst auf 5 MB begrenzt
      .use((c, next) =>
        c.req.method === "PUT" && c.req.path === "/api/v1/ich/bild"
          ? next()
          : kleinesLimit(c, next),
      )
      .use("/api/*", async (c, next) => {
        const version = c.req.header("X-App-Version");
        // Ohne Header weiter: 426 nur für eine ältere Version; den Header setzt der Client selbst, aussperren kann die Prüfung also niemanden
        if (version !== undefined && istVeraltet(version, appMinVersion)) {
          throw new HTTPException(426);
        }
        await next();
      })
      .route("/", erstelleAuthRouten(auth))
      // Einen Origin sendet nur ein Browser (die Verwaltung), die App nicht; erlaubt ist dieselbe Liste, die better-auth unter /api/auth prüft: BETTER_AUTH_URL und das App-Schema. Vor der Sitzung, damit eine fremde Seite keine Abfrage auslöst
      .use("/api/v1/*", async (c, next) => {
        const herkunft = c.req.header("Origin");
        if (
          herkunft !== undefined &&
          !LESEND.has(c.req.method) &&
          !(await auth.$context).isTrustedOrigin(herkunft)
        ) {
          throw new HTTPException(403);
        }
        await next();
      })
      // Unbekannte Pfade unter /api/v1 antworten ohne Sitzung 401, mit Sitzung 404
      .use("/api/v1/*", personAusSitzung(auth, db))
      .use("/api/v1/admin/*", zweiterFaktorPflicht)
      .route("/api/v1", erstelleProfilbildRouten({ db, kodiereBild }))
      .route("/api/v1/ich", erstelleIchRouten({ db }))
      .route("/api/v1/programme", erstelleProgrammRouten({ db, fcm }))
      .route("/api/v1/einwilligung", erstelleEinwilligungRouten({ db }))
      .route("/api/v1/admin/einheiten", erstelleEinheitenRouten({ db }))
      .route(
        "/api/v1/admin/einheiten/:einheitId/zeitregeln",
        erstelleZeitregelRouten({ db }),
      )
      .route(
        "/api/v1/admin/einheiten/:einheitId/lodur",
        erstelleLodurRouten({ db, erlaubteHosts: lodurErlaubteHosts }),
      )
      .route("/api/v1/admin/system", erstelleSystemRouten({ sql, metriken }))
      .route("/api/v1/push-token", erstellePushTokenRouten({ db }))
      .get("/health", async (c) => {
        try {
          // Alarm, wenn der Sync einer Einheit seit einer Stunde (vier Läufe) nicht gelungen ist; vor dem ersten Erfolg zählt der Zeitpunkt, an dem der Link eingetragen wurde
          const [stand] = await sql<{ veraltet: boolean }[]>`
            select exists(
              select 1 from einheit
              where lodur_url_verschluesselt is not null
                and coalesce(sync_ok_am, lodur_url_gesetzt_am) < now() - interval '60 minutes'
            ) as veraltet`;
          if (stand!.veraltet) {
            // Ohne Einheit und ohne Link: /health ist offen
            log(c, { ereignis: "health", code: "sync-veraltet" });
            return c.text("sync-veraltet", 503);
          }
          return c.text("ok");
        } catch (fehler) {
          // Nur der Code: postgres-js nennt Host und Port in message, address und port
          log(c, {
            ereignis: "health",
            code: (fehler as { code?: unknown }).code,
          });
          return c.text("fehler", 503);
        }
      })
      // Seiten für die Stores, ohne Login und ausserhalb der Versionsprüfung; die Texte folgen in #63
      .get("/datenschutz", (c) => c.html(seiten.datenschutz))
      .get("/konto-loeschen", (c) => c.html(seiten.kontoLoeschen))
      .get("/support", (c) => c.html(seiten.support))
      // Verwaltung im Browser (#141): nur die statische Hülle, Daten kommen über /api/v1/admin/*
      .route("/admin", erstelleAdminSeiten(seiten.admin))
      // Eigene Routen statt Dateien, damit der Content-Type JSON ist; die Inhalte folgen in #24
      .get("/.well-known/apple-app-site-association", (c) => c.json({}))
      .get("/.well-known/assetlinks.json", (c) => c.json([]))
      .notFound((c) => c.json(FEHLER[404], 404))
      .onError((fehler, c) => {
        if (fehler instanceof HTTPException) {
          return c.json(
            FEHLER[fehler.status] ?? {
              code: "FEHLER",
              message: "Anfrage fehlgeschlagen",
            },
            fehler.status,
          );
        }
        // Ohne Meldung: Sie kann Eingaben (Postgres) oder Hosts wiederholen
        log(c, {
          ereignis: "fehler",
          name: fehler.name,
          code: (fehler as { code?: unknown }).code,
          // Erst nach dem Kopf «Name: Meldung», den Node mit Error.prototype.toString bildet: Eine mehrzeilige Meldung kann Zeilen mit «at …» enthalten
          stack: fehler.stack
            ?.split("\n")
            .slice(Error.prototype.toString.call(fehler).split("\n").length)
            .filter((z) => /^\s+at /.test(z)),
        });
        return c.json(FEHLER[500], 500);
      })
  );
}

export type AppType = ReturnType<typeof erstelleApp>;
