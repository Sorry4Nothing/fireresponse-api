import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";

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

// Löst einen Host in seine IP-Adressen auf; im Test eine Attrappe
export type Aufloesen = (host: string) => Promise<string[]>;
export const dnsAufloesen: Aufloesen = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

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
  if (text.length > MAX_LAENGE || /[\s\\\p{Cc}]/u.test(text)) {
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

// Loopback, private, Link-Local- und weitere nicht öffentliche Bereiche (IPv4, IPv6, IPv4-mapped)
export function istNichtOeffentlich(ip: string): boolean {
  if (isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  const gemappt = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (gemappt) return istNichtOeffentlich(gemappt[1]!);
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("::ffff:") ||
    /^f[cd]/.test(v6) ||
    /^fe[89ab]/.test(v6)
  );
}

// SR-26: Auch ein erlaubter Host darf nicht auf eine interne Adresse zeigen. shortcut: Die Auflösung gilt für diese Prüfung, fetch löst danach selbst noch einmal auf (DNS-Rebinding bliebe möglich); schliessen mit einem eigenen Dispatcher, der die geprüfte Adresse verbindet, sobald Hosts Dritter in die Allowlist kommen
export async function pruefeAdresse(
  host: string,
  aufloesen: Aufloesen = dnsAufloesen,
) {
  let adressen: string[];
  try {
    adressen = await aufloesen(host);
  } catch {
    throw new LodurFehler("netzwerk");
  }
  if (adressen.length === 0 || adressen.some(istNichtOeffentlich)) {
    throw new LodurFehler("url-ungueltig");
  }
}

// membear: Der Link der Kalenderseite (/calendar/<verein>?token=…) ist HTML; den ICS-Kalender liefert /api/v1/<verein>/events/calendar mit demselben Token. Host und Schema bleiben, die Prüfung mit pruefeLodurUrl gilt weiter
export function icsAdresse(url: URL): URL {
  const m = /^\/calendar\/([\w-]+)\/?$/.exec(url.pathname);
  if (!m || url.hostname !== "www.membear.ch") return url;
  const ics = new URL(url.href);
  ics.pathname = `/api/v1/${m[1]}/events/calendar`;
  ics.search = "";
  const token = url.searchParams.get("token");
  if (token) ics.searchParams.set("token", token);
  return ics;
}

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
      headers: { Accept: "text/html, text/calendar;q=0.9, text/plain;q=0.5" },
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
  const bytes = Buffer.concat(teile);
  // Lodur liefert iso-8859-1; der Zeichensatz steht im Header oder im meta-Tag (der Kopf der Seite ist ASCII)
  const charset =
    /charset=["']?([\w-]+)/i.exec(
      antwort.headers.get("content-type") ?? "",
    )?.[1] ??
    /<meta[^>]*charset=["']?([\w-]+)/i.exec(
      bytes.subarray(0, 2048).toString("latin1"),
    )?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// Der gleiche Link für ein anderes Jahr; ohne Parameter year bleibt er, wie er ist. Der Aufrufer prüft das Ergebnis wieder mit pruefeLodurUrl (SR-26)
export function jahresLink(link: string, jahr: number): string {
  const url = new URL(link);
  if (!url.searchParams.has("year")) return link;
  url.searchParams.set("year", String(jahr));
  return url.href;
}
