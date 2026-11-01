import type { Context } from "hono";

// Eine JSON-Zeile pro Eintrag; die Felder wählt der Aufrufer, nie Header, Body, Query oder IP-Adresse
// Ohne Context (Jobs ausserhalb einer Anfrage) fällt die Request-ID weg
export function log(c: Context | undefined, felder: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      zeit: new Date().toISOString(),
      requestId: c?.get("requestId"),
      ...felder,
    }),
  );
}

// Der Code ist gefahrlos (ENOENT, 22021, …); DrizzleQueryError trägt ihn in der Ursache
export function fehlerCode(fehler: unknown) {
  const f = fehler as { code?: unknown; cause?: { code?: unknown } };
  return f?.code ?? f?.cause?.code;
}
