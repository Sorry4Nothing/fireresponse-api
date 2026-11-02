// Der Lodur-Link ist ein Geheimnis (er gibt den Kalender frei) und zugleich eine Adresse, die der Server abruft. Hier steht, was die API davon annimmt und wie sie ihn abruft (SR-26): nur https, nur ein Host aus LODUR_ERLAUBTE_HOSTS, kein Port, keine Zugangsdaten, keine Weiterleitung, Zeitlimit und Grössenlimit.

// Nur diese Codes landen in Log und in einheit.sync_fehler, nie eine Meldung (sie könnte den Link enthalten)
export type LodurCode =
  | "url-ungueltig"
  | "entschluesselung"
  | "weiterleitung"
  | "http-fehler"
  | "zeitueberschreitung"
  | "netzwerk"
  | "zu-gross"
  | "kein-kalender"
  | "leer";

export class LodurFehler extends Error {
  constructor(readonly code: LodurCode) {
    super(code);
  }
}

// Schlüsselzweck der Verschlüsselung des Links (startpasswort.ts)
export const ZWECK_LODUR_LINK = "lodur-link";

export type Abruf = (url: URL, optionen: RequestInit) => Promise<Response>;

const MAX_LAENGE = 2048;
export const MAX_BYTES = 5 * 1024 * 1024;
export const ZEITLIMIT_MS = 15_000;

// Wirft LodurFehler("url-ungueltig"). shortcut: Die Prüfung gilt dem Namen, nicht der aufgelösten Adresse; ein erlaubter Host, der auf eine interne Adresse zeigt, wäre ein Fehler des Betreibers der Allowlist. Bei Hosts Dritter zusätzlich die Adresse nach der DNS-Auflösung prüfen
export function pruefeLodurUrl(
  text: string,
  erlaubteHosts: readonly string[],
): URL {
  const ungueltig = () => new LodurFehler("url-ungueltig");
  // Leerzeichen, Steuerzeichen und Backslash lesen Parser verschieden (WHATWG macht aus «\» einen «/»)
  if (text.length > MAX_LAENGE || /[\s\\\u0000-\u001f\u007f]/.test(text)) {
    throw ungueltig();
  }
  const rest = /^https:\/\/([^/?#]*)/i.exec(text);
  // Die Rohform der Autorität: «@» (Zugangsdaten) und «:» (Port, IPv6) kommen nicht vor
  if (!rest || /[@:]/.test(rest[1]!)) throw ungueltig();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw ungueltig();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.host !== rest[1]!.toLowerCase() ||
    !erlaubteHosts.includes(url.hostname)
  ) {
    throw ungueltig();
  }
  return url;
}

// Für die Anzeige im Panel: Host ja, Pfad und Schlüssel nie
export const maskiere = (url: string) => {
  try {
    return `https://${new URL(url).hostname}/…`;
  } catch {
    return null;
  }
};

// Der Aufrufer prüft die URL vorher mit pruefeLodurUrl
export async function holeKalender(
  url: URL,
  abruf: Abruf = fetch,
): Promise<string> {
  const signal = AbortSignal.timeout(ZEITLIMIT_MS);
  const abbruch = (f: unknown) =>
    new LodurFehler(
      (f as { name?: string })?.name === "TimeoutError"
        ? "zeitueberschreitung"
        : "netzwerk",
    );
  let antwort: Response;
  try {
    // manual: Eine Weiterleitung folgt der Server nie (sie könnte auf einen fremden Host zeigen)
    antwort = await abruf(url, {
      redirect: "manual",
      signal,
      headers: { Accept: "text/calendar, text/plain;q=0.5" },
    });
  } catch (fehler) {
    throw abbruch(fehler);
  }
  if (antwort.status >= 300 && antwort.status < 400) {
    await antwort.body?.cancel().catch(() => {});
    throw new LodurFehler("weiterleitung");
  }
  if (!antwort.ok) {
    await antwort.body?.cancel().catch(() => {});
    throw new LodurFehler("http-fehler");
  }
  if (Number(antwort.headers.get("content-length")) > MAX_BYTES) {
    await antwort.body?.cancel().catch(() => {});
    throw new LodurFehler("zu-gross");
  }
  const teile: Uint8Array[] = [];
  let summe = 0;
  try {
    const leser = antwort.body?.getReader();
    for (;;) {
      const gelesen = await leser?.read();
      if (!gelesen || gelesen.done) break;
      summe += gelesen.value.byteLength;
      if (summe > MAX_BYTES) {
        await leser!.cancel().catch(() => {});
        throw new LodurFehler("zu-gross");
      }
      teile.push(gelesen.value);
    }
  } catch (fehler) {
    throw fehler instanceof LodurFehler ? fehler : abbruch(fehler);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(teile));
}
