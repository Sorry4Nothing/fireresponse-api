// Erzeugt docs/api/endpunkte.md und postman/collections/FireResponse API/ aus apps/api/.postman-lokal/matrix.json (#186)
// Voraussetzung: POSTMAN_EXPORT=1 vitest run test/rechte-matrix.test.ts -t Postman-Export; Ablauf in docs/api/postman.md
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const wurzel = new URL("../../../", import.meta.url);
const matrix = JSON.parse(
  readFileSync(new URL("apps/api/.postman-lokal/matrix.json", wurzel), "utf8"),
);
const openapi = parse(
  readFileSync(new URL("docs/api/openapi.yaml", wurzel), "utf8"),
);
const alle = matrix.personas;

const yamlText = (text) => JSON.stringify(text);
const block = (text, einzug) =>
  text
    .split("\n")
    .map((zeile) => (zeile ? " ".repeat(einzug) + zeile : zeile))
    .join("\n");
const dateiname = (schluessel) =>
  schluessel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

function bereich(pfad) {
  if (pfad.startsWith("/api/auth/")) return "Anmeldung (better-auth)";
  if (pfad.startsWith("/api/v1/admin/")) return "Verwaltung";
  const teil = /^\/api\/v1\/([^/?]+)/.exec(pfad)?.[1];
  return teil ? `App: ${teil}` : "Seiten und Gesundheit";
}

// Zweck aus openapi.yaml; Pfad-Parameter heissen dort {id}, in der Matrix :id
function zweck(zeile) {
  const pfad = zeile.schluessel.split(" ")[1].replace(/:(\w+)/g, "{$1}");
  const eintrag = openapi.paths[pfad]?.[zeile.methode.toLowerCase()];
  return eintrag?.summary ?? "";
}

function zugriff(zeile) {
  const nachStatus = new Map();
  for (const persona of alle) {
    const status = zeile.erwartet[persona];
    nachStatus.set(status, [...(nachStatus.get(status) ?? []), persona]);
  }
  return [...nachStatus]
    .sort(([a], [b]) => a - b)
    .map(([status, personen]) => {
      const namen =
        personen.length === alle.length ? "alle" : personen.join(", ");
      return `**${status}** ${namen}`;
    })
    .join("<br>");
}

// docs/api/endpunkte.md
const nachBereich = Map.groupBy(matrix.zeilen, (z) =>
  bereich(z.schluessel.split(" ")[1]),
);
let md = `# Endpunkte und Zugriff

Erzeugt aus der Rechte-Matrix (\`apps/api/test/rechte-matrix.test.ts\`) und \`docs/api/openapi.yaml\`; nicht von Hand ändern. Neu erzeugen: siehe [postman.md](postman.md).

Je Route steht, welche Persona welchen Status bekommt. 2xx heisst erlaubt, 401 nicht angemeldet, 403 angemeldet ohne Recht, 404 das Objekt gehört einer anderen Stufe oder Abteilung und ist unsichtbar. Die Personas beschreibt \`apps/api/test/hilfen/personas.ts\`.

`;
for (const [name, zeilen] of nachBereich) {
  md += `## ${name}\n\n| Route | Zweck | Status je Persona |\n| --- | --- | --- |\n`;
  for (const z of zeilen)
    md += `| \`${z.schluessel}\` | ${zweck(z)} | ${zugriff(z)} |\n`;
  md += "\n";
}
writeFileSync(new URL("docs/api/endpunkte.md", wurzel), md);

// postman/collections/FireResponse API/
const sammlung = new URL("postman/collections/FireResponse API/", wurzel);
rmSync(sammlung, { recursive: true, force: true });
const schreibe = (pfad, inhalt) => {
  const url = new URL(pfad, sammlung);
  mkdirSync(new URL(".", url), { recursive: true });
  writeFileSync(url, inhalt);
};

const pruefung = `const erwartet = JSON.parse(pm.environment.get("erwartet"))[pm.info.requestName];
pm.test(pm.environment.get("persona") + ": " + pm.info.requestName + " -> " + erwartet, () => {
  pm.response.to.have.status(erwartet);
});`;
schreibe(
  ".resources/definition.yaml",
  `$kind: collection
name: FireResponse API
description: "Jede Route der Rechte-Matrix. Mit einer Umgebung je Persona laufen lassen; der Test erwartet den Status, den die Matrix für diese Persona festhält. Ablauf: docs/api/postman.md"
variables:
  - key: appVersion
    value: "1.2.0"
scripts:
  - type: http:afterResponse
    language: text/javascript
    code: |-
${block(pruefung, 6)}
`,
);

// Beide beenden die Sitzung der Persona, also laufen sie nach allen anderen Anfragen; sign-out gibt auch ohne Sitzung 200
const reihenfolge = (z, nr) =>
  z.schluessel === "POST /api/auth/revoke-sessions"
    ? 98000
    : z.schluessel === "POST /api/auth/sign-out"
      ? 99000
      : nr * 1000;
const ordner = new Map();
const json = new Map(); // Ordnername -> [Reihenfolge, Anfrage] für die Datei zum Importieren
let nr = 0;
for (const z of matrix.zeilen) {
  if (z.bild) continue; // Binärer Body; die Zeile prüft nur die Matrix im Test
  const pfad = z.schluessel.split(" ")[1];
  const name = z.sitzungEnde ? "Beendet die Sitzung (zuletzt)" : bereich(pfad);
  if (!ordner.has(name)) {
    ordner.set(name, ordner.size + 1);
    schreibe(
      `${dateiname(name)}/.resources/definition.yaml`,
      `$kind: collection\nname: ${yamlText(name)}\norder: ${z.sitzungEnde ? 90000 : ordner.size * 1000}\n`,
    );
  }
  // Die API lehnt POST, PUT und PATCH ohne JSON-Body mit 415 ab
  const hatBody = z.body || (z.methode !== "GET" && z.methode !== "DELETE");
  const text = z.body ?? "{}";
  const kopf = [
    ["Cookie", "{{cookie}}"],
    ["expo-origin", "{{expoOrigin}}"],
    ["X-Forwarded-For", "{{ip}}"],
    ["X-App-Version", "{{appVersion}}"],
    ...(hatBody ? [["Content-Type", "application/json"]] : []),
  ];
  const inhalt = z.bodyJePersona
    ? `{{body_${z.n}}}`
    : JSON.stringify(
        JSON.parse(text.replace(/\{\{(\w+)\}\}/g, "<<$1>>")),
        null,
        2,
      ).replace(/<<(\w+)>>/g, "{{$1}}");
  const koerper = hatBody
    ? `body:\n  type: json\n  content: |-\n${block(inhalt, 4)}\n`
    : "";
  const reihe = reihenfolge(z, nr + 1);
  json.set(name, [
    ...(json.get(name) ?? []),
    [
      reihe,
      {
        name: z.schluessel,
        request: {
          method: z.methode,
          header: kopf.map(([key, value]) => ({ key, value })),
          url: "{{baseUrl}}" + z.pfad,
          ...(hatBody && {
            body: {
              mode: "raw",
              raw: inhalt,
              options: { raw: { language: "json" } },
            },
          }),
        },
      },
    ],
  ]);
  schreibe(
    `${dateiname(name)}/${dateiname(z.schluessel)}.request.yaml`,
    `$kind: http-request
name: ${yamlText(z.schluessel)}
order: ${reihenfolge(z, ++nr)}
method: ${z.methode}
url: ${yamlText("{{baseUrl}}" + z.pfad)}
headers:
${kopf.map(([k, v]) => `  - key: ${yamlText(k)}\n    value: ${yamlText(v)}`).join("\n")}
${koerper}`,
  );
}
// Einzelne Datei im Format v2.1 für den Import in die Postman-App; die App liest den Ordner oben nicht
writeFileSync(
  new URL(
    "apps/api/.postman-lokal/FireResponse-API.postman_collection.json",
    wurzel,
  ),
  JSON.stringify(
    {
      info: {
        name: "FireResponse API",
        schema:
          "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      variable: [{ key: "appVersion", value: "1.2.0" }],
      event: [
        {
          listen: "test",
          script: { type: "text/javascript", exec: pruefung.split("\n") },
        },
      ],
      item: [...json]
        .sort(([a], [b]) =>
          a.startsWith("Beendet") ? 1 : b.startsWith("Beendet") ? -1 : 0,
        )
        .map(([name, anfragen]) => ({
          name,
          item: anfragen
            .sort(([a], [b]) => a - b)
            .map(([, anfrage]) => anfrage),
        })),
    },
    null,
    2,
  ),
);
console.log(
  `${nr} Anfragen, ${matrix.zeilen.length - nr} ohne Anfrage (Bild-Upload)`,
);
