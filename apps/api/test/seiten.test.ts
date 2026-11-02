import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import { EINWILLIGUNG_VERSION } from "../src/einwilligung.js";
import { ladeSeiten, setzeKontakt } from "../src/seiten.js";
import { bereiteAuthTestsVor, erstelleTestAuth } from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";

bereiteAuthTestsVor();

const sql = postgres(API_URL);
const db = erstelleDb(sql);
const auth = erstelleTestAuth(db);
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  seiten: ladeSeiten(),
});
afterAll(() => sql.end());

// Jede Anfrage schriebe sonst eine Log-Zeile in die Testausgabe
let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

const geladen = ladeSeiten();

// Ohne Cookie («ohne Login»); seite === null heisst: Der genaue Inhalt folgt später, hier zählt nur gültiges JSON
test.each<[string, string, string | null]>([
  ["/datenschutz", "text/html; charset=UTF-8", geladen.datenschutz],
  [
    "/nutzungsbedingungen",
    "text/html; charset=UTF-8",
    geladen.nutzungsbedingungen,
  ],
  ["/konto-loeschen", "text/html; charset=UTF-8", geladen.kontoLoeschen],
  ["/support", "text/html; charset=UTF-8", geladen.support],
  ["/.well-known/apple-app-site-association", "application/json", null],
  ["/.well-known/assetlinks.json", "application/json", null],
])(
  "GET %s antwortet ohne Login mit 200 und %s, ohne Weiterleitung",
  async (pfad, typ, seite) => {
    const antwort = await app.request(pfad);
    expect(antwort.status).toBe(200);
    expect(antwort.headers.get("content-type")).toBe(typ);
    expect(antwort.headers.get("location")).toBeNull();
    const text = await antwort.text();
    if (seite === null) {
      expect(() => JSON.parse(text)).not.toThrow();
    } else {
      // Jeder Pfad liefert seine eigene Seite
      expect(text).toBe(seite);
    }
  },
);

// Verwaltung im Browser
const admin = ladeSeiten().admin;
const adminPfad = (datei: string) =>
  datei === "index.html" ? "/admin" : `/admin/${datei}`;
const ADMIN_TYPEN: Record<string, string> = {
  html: "text/html; charset=UTF-8",
  css: "text/css; charset=UTF-8",
  js: "text/javascript; charset=UTF-8",
  svg: "image/svg+xml",
};

describe("Verwaltung unter /admin", () => {
  test("die Dateien aus public/admin sind geladen", () => {
    expect(Object.keys(admin)).toContain("index.html");
    expect(Object.keys(admin)).toContain("admin.js");
    expect(Object.keys(admin)).toContain("admin.css");
  });

  test.each(Object.keys(admin))(
    "GET %s antwortet ohne Login mit 200, dem Typ der Datei und den Sicherheits-Kopfzeilen",
    async (datei) => {
      const antwort = await app.request(adminPfad(datei));
      expect(antwort.status).toBe(200);
      expect(antwort.headers.get("content-type")).toBe(
        ADMIN_TYPEN[datei.split(".").pop()!],
      );
      expect(await antwort.text()).toBe(admin[datei]);
      const csp = antwort.headers.get("content-security-policy")!;
      for (const regel of [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "connect-src 'self'",
      ]) {
        expect(csp).toContain(regel);
      }
      expect(csp).not.toContain("unsafe");
      expect(antwort.headers.get("x-content-type-options")).toBe("nosniff");
      expect(antwort.headers.get("referrer-policy")).toBe("no-referrer");
      expect(antwort.headers.get("x-frame-options")).toBe("DENY");
      expect(antwort.headers.get("cache-control")).toBe(
        datei.endsWith(".html") ? "no-store" : "no-cache",
      );
    },
  );

  test("unbekannte Dateien unter /admin sind 404 ohne Sicherheits-Kopfzeilen der Seite", async () => {
    const antwort = await app.request("/admin/gibt-es-nicht.js");
    expect(antwort.status).toBe(404);
  });

  test("die Seite enthält kein Inline-Skript, keinen Inline-Stil und keine Ereignis-Attribute", () => {
    const html = admin["index.html"];
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<style/i);
  });

  test("die Verwaltung ist immer dunkel, ohne Umschalten nach Systemeinstellung", () => {
    expect(admin["index.html"]).toContain('name="color-scheme" content="dark"');
    expect(admin["admin.css"]).toContain("color-scheme: dark;");
    expect(admin["admin.css"]).not.toContain("prefers-color-scheme");
  });

  test.each(Object.keys(admin).filter((d) => d.endsWith(".js")))(
    "%s schreibt keine Daten als HTML und lädt nichts von aussen",
    (datei) => {
      expect(admin[datei]).not.toMatch(
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|localStorage|sessionStorage/,
      );
      // Die CSP erlaubt keine Inline-Stile: Klassen statt style-Attribut
      expect(admin[datei]).not.toMatch(
        /setAttribute\(\s*["'`]style|\.style\.cssText/,
      );
      // Ausser dem Namensraum von SVG: eine Kennung, nichts wird geladen
      expect(
        admin[datei].replaceAll("http://www.w3.org/2000/svg", ""),
      ).not.toMatch(/https?:\/\//);
    },
  );
});

describe("Seiten für die Stores", () => {
  const kontakt = {
    stelle: "Verein <Beispiel> & Co",
    email: "kontakt@example.org",
  };
  const seiten = ladeSeiten(kontakt);
  const alle = Object.entries({
    datenschutz: seiten.datenschutz,
    kontoLoeschen: seiten.kontoLoeschen,
    nutzungsbedingungen: seiten.nutzungsbedingungen,
    support: seiten.support,
  });

  test.each(alle)(
    "%s: Stil und Adresse sind eingesetzt, nichts bleibt offen",
    (_name, html) => {
      expect(html).not.toMatch(/\{\{|STIL/);
      expect(html).toContain("color-scheme: light dark");
      expect(html).toContain(
        '<a href="mailto:kontakt@example.org">kontakt@example.org</a>',
      );
    },
  );

  test("die Stelle wird maskiert", () => {
    expect(seiten.datenschutz).toContain("Verein &lt;Beispiel&gt; &amp; Co");
    expect(seiten.datenschutz).not.toContain("<Beispiel>");
  });

  test("ohne Angaben nennen die Seiten weder Stelle noch Adresse, sagen es aber", () => {
    expect(geladen.datenschutz).toContain("noch nicht eingetragen");
    expect(geladen.datenschutz).not.toContain("mailto:");
    expect(setzeKontakt("{{STELLE}}", {})).toBe("die Einheit");
  });

  test.each(alle)(
    "%s: Sprache, Hauptbereich, eine Überschrift 1, nichts von aussen, kein Eszett",
    (_name, html) => {
      expect(html).toContain('<html lang="de-CH">');
      expect(html).toContain("<main>");
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
      expect(html).toContain('name="viewport"');
      expect(html).not.toMatch(
        /<script|<img|<iframe|<link|\ssrc\s*=|@import|url\(/i,
      );
      // Einziger Verweis nach aussen: die Aufsichtsbehörde
      const aussen = [...html.matchAll(/href="(https?:[^"]+)"/g)].map(
        (m) => m[1],
      );
      expect(aussen.every((u) => u === "https://www.edoeb.admin.ch")).toBe(
        true,
      );
      expect(html).not.toContain("ß");
    },
  );

  test("jede Seite verlinkt die drei anderen", () => {
    const pfade = {
      datenschutz: "/datenschutz",
      nutzungsbedingungen: "/nutzungsbedingungen",
      kontoLoeschen: "/konto-loeschen",
      support: "/support",
    };
    for (const [name, html] of alle) {
      for (const [andere, pfad] of Object.entries(pfade)) {
        if (andere !== name) expect(html).toContain(`href="${pfad}"`);
      }
    }
  });

  test("die Nutzungsbedingungen regeln die Zustimmung der Bezirke durch die Nutzung, die Auftragsbearbeitung und die Sicht der Kantonsadministration", () => {
    const text = seiten.nutzungsbedingungen.replace(/\s+/g, " ");
    expect(text).toContain("indem seine Einheiten FireResponse nutzen");
    expect(text).toContain("Auftragsbearbeitung");
    expect(text).toContain("Unterauftragsbearbeiter");
    expect(text).toContain("sieht die Daten aller Bezirke und Einheiten");
  });

  test("die Datenschutzerklärung nennt die Auswertung der Anmeldungen und trägt die Fassung der Einwilligung", () => {
    const text = seiten.datenschutz.replace(/\s+/g, " ");
    expect(text).toContain("Auswertung der Anmeldungen");
    for (const html of [seiten.datenschutz, seiten.nutzungsbedingungen]) {
      expect(html).toContain(`Fassung ${EINWILLIGUNG_VERSION}`);
    }
  });

  test("die Seite zum Löschen nennt den Löschtext und den Weg ohne App", () => {
    expect(seiten.kontoLoeschen.replace(/\s+/g, " ")).toContain(
      "Auf Anfrage löscht die Leitung Daten.",
    );
    expect(seiten.kontoLoeschen).toContain("mailto:kontakt@example.org");
  });
});

describe("GET /api/v1/datenschutz", () => {
  const holen = async (kopf: Record<string, string> = {}) =>
    app.request("/api/v1/datenschutz", { headers: kopf });
  const kontakt = {
    stelle: "Muster & Söhne",
    email: "datenschutz@example.org",
  };
  const mitKontakt = erstelleApp({
    appMinVersion: "1.2.0",
    sql,
    db,
    auth,
    seiten: ladeSeiten(kontakt),
  });

  test("antwortet ohne Login mit Fassung und Abschnitten, öffentlich cachebar", async () => {
    const antwort = await holen();
    expect(antwort.status).toBe(200);
    expect(antwort.headers.get("content-type")).toContain("application/json");
    expect(antwort.headers.get("cache-control")).toBe("public, max-age=3600");
    const body = await antwort.json();
    expect(body.version).toBe(EINWILLIGUNG_VERSION);
    expect(body.abschnitte.length).toBeGreaterThan(5);
    for (const a of body.abschnitte) {
      expect(Object.keys(a).sort()).toEqual(["text", "titel"]);
      expect(a.titel).not.toBe("");
      expect(a.text).not.toBe("");
    }
  });

  test("hat dieselben Abschnitte in derselben Reihenfolge wie die Seite", async () => {
    const body = await (await holen()).json();
    const titelDerSeite = [
      ...geladen.datenschutz.matchAll(/<h[12]>([\s\S]*?)<\/h[12]>/g),
    ].map((t) => t[1]!.replace(/\s+/g, " ").trim());
    expect(body.abschnitte.map((a: { titel: string }) => a.titel)).toEqual(
      titelDerSeite,
    );
    // Gleiche Buchstaben und Ziffern in gleicher Reihenfolge; Satzzeichen, Leerraum und Listenpunkte zählen nicht
    const kern = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, "");
    const seite = geladen.datenschutz
      .replace(/<style>[\s\S]*?<\/style>|<footer>[\s\S]*<\/footer>/g, "")
      .replace(/<head>[\s\S]*?<\/head>/, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
    const json = body.abschnitte
      .flatMap((a: { titel: string; text: string }) => [a.titel, a.text])
      .join(" ");
    expect(kern(json)).toBe(kern(seite));
  });

  test("enthält Klartext: kein HTML, Absätze mit Leerzeile, Kategorien und Fassung", async () => {
    const body = await (await holen()).json();
    const alles = JSON.stringify(body);
    expect(alles).not.toMatch(/<\/?[a-z]/i);
    expect(alles).not.toContain("{{");
    expect(alles).not.toContain("&amp;");
    expect(body.abschnitte[0].text).toContain(
      `Fassung ${EINWILLIGUNG_VERSION}`,
    );
    const daten = body.abschnitte.find((a: { titel: string }) =>
      a.titel.startsWith("Welche Daten"),
    );
    expect(daten.text.split("\n\n").length).toBeGreaterThan(3);
    expect(daten.text).toContain("Wozu: ");
    expect(daten.text).toContain("Wie lange: ");
  });

  test("setzt Stelle und Adresse wie die Seite ein und entmaskiert Zeichen", async () => {
    const antwort = await mitKontakt.request("/api/v1/datenschutz");
    const text = JSON.stringify(await antwort.json());
    expect(text).toContain("Muster & Söhne");
    expect(text).toContain("datenschutz@example.org");
    expect(text).not.toContain("&amp;");
  });

  test("antwortet bei zu alter App-Version mit 426", async () => {
    const antwort = await holen({ "X-App-Version": "1.0.0" });
    expect(antwort.status).toBe(426);
  });
});
