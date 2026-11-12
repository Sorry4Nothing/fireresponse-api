import { describe, expect, test, vi } from "vitest";
import {
  holeKalender,
  icsAdresse,
  istNichtOeffentlich,
  LodurFehler,
  MAX_BYTES,
  maskiere,
  pruefeAdresse,
  pruefeLodurUrl,
  type Abruf,
} from "../src/lodur-url.js";
import {
  entschluessele,
  entschluesseleStartpasswort,
  verschluessele,
  verschluesseleStartpasswort,
} from "../src/startpasswort.js";

const HOSTS = ["kalender.example.org"];
const GUT = "https://kalender.example.org/ical/geheim-123?key=abc";

const code = (aufruf: () => unknown) => {
  try {
    aufruf();
  } catch (fehler) {
    return (fehler as LodurFehler).code;
  }
  return undefined;
};
const codeAsync = (aufruf: () => Promise<unknown>) =>
  aufruf().then(
    () => undefined,
    (fehler: LodurFehler) => fehler.code,
  );

describe("pruefeLodurUrl (SR-26)", () => {
  test("nimmt https mit erlaubtem Host an, auch in anderer Schreibweise", () => {
    expect(pruefeLodurUrl(GUT, HOSTS).href).toBe(GUT);
    expect(
      pruefeLodurUrl("HTTPS://Kalender.Example.ORG/x", HOSTS).hostname,
    ).toBe("kalender.example.org");
  });

  test.each([
    ["http statt https", "http://kalender.example.org/x"],
    ["anderer Schema", "ftp://kalender.example.org/x"],
    ["ohne Schema", "kalender.example.org/x"],
    ["fremder Host", "https://boese.example.net/x"],
    ["Unterdomain des erlaubten Hosts", "https://a.kalender.example.org/x"],
    [
      "Host als Unterdomain eines fremden",
      "https://kalender.example.org.boese.net/x",
    ],
    ["Host mit Punkt am Ende", "https://kalender.example.org./x"],
    ["Port", "https://kalender.example.org:8443/x"],
    ["Standardport 443", "https://kalender.example.org:443/x"],
    ["Zugangsdaten", "https://nutzer:pw@kalender.example.org/x"],
    ["Benutzer ohne Passwort", "https://nutzer@kalender.example.org/x"],
    [
      "@ im Pfad vor dem erlaubten Host",
      "https://boese.example.net@kalender.example.org/x",
    ],
    [
      "Backslash als Trenner",
      String.raw`https://boese.example.net\@kalender.example.org/x`,
    ],
    [
      "Backslash vor dem Pfad",
      String.raw`https://kalender.example.org\.boese.net/x`,
    ],
    ["IPv4", "https://127.0.0.1/x"],
    ["IPv4 als Zahl", "https://2130706433/x"],
    ["IPv6", "https://[::1]/x"],
    ["localhost", "https://localhost/x"],
    ["Leerzeichen", "https://kalender.example.org/a b"],
    ["Zeilenumbruch", "https://kalender.example.org/x\nHost: boese"],
    ["Tab im Host", "https://kalender\t.example.org/x"],
    ["zu lang", `https://kalender.example.org/${"a".repeat(2100)}`],
    ["leer", ""],
  ])("lehnt ab: %s", (_, url) => {
    expect(code(() => pruefeLodurUrl(url, HOSTS))).toBe("url-ungueltig");
  });

  test("ohne erlaubte Hosts geht nichts durch", () => {
    expect(code(() => pruefeLodurUrl(GUT, []))).toBe("url-ungueltig");
  });
});

describe("maskiere", () => {
  test("nennt nur den Host, nie Pfad oder Schlüssel", () => {
    expect(maskiere(GUT)).toBe("https://kalender.example.org/…");
    expect(maskiere(GUT)).not.toContain("geheim");
    expect(maskiere(GUT)).not.toContain("abc");
    expect(maskiere("kein link")).toBeNull();
  });
});

describe("holeKalender", () => {
  const url = new URL(GUT);
  const mit = (antwort: () => Response | Promise<Response>): Abruf =>
    vi.fn(async () => antwort());

  test("liest den Text und fordert keine Weiterleitung an", async () => {
    const abruf = mit(() => new Response("BEGIN:VCALENDAR\r\nÜ"));
    expect(await holeKalender(url, abruf)).toBe("BEGIN:VCALENDAR\r\nÜ");
    expect(abruf).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  test.each([301, 302, 307, 308])(
    "Weiterleitung %i ist ein Fehler",
    async (status) => {
      const abruf = mit(
        () =>
          new Response(null, {
            status,
            headers: { location: "https://boese.example.net/" },
          }),
      );
      expect(await codeAsync(() => holeKalender(url, abruf))).toBe(
        "weiterleitung",
      );
      // Nur ein Aufruf: Der Server folgt dem Location-Header nie
      expect(abruf).toHaveBeenCalledTimes(1);
    },
  );

  test.each([401, 404, 500])("HTTP %i ist ein Fehler", async (status) => {
    const abruf = mit(() => new Response("nein", { status }));
    expect(await codeAsync(() => holeKalender(url, abruf))).toBe("http-fehler");
  });

  test("zu grosse Antwort: schon am Header, und beim Lesen ohne Header", async () => {
    const gross = mit(
      () =>
        new Response("x", {
          headers: { "content-length": String(MAX_BYTES + 1) },
        }),
    );
    expect(await codeAsync(() => holeKalender(url, gross))).toBe("zu-gross");
    const strom = mit(
      () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array(1024 * 1024));
            },
          }),
        ),
    );
    expect(await codeAsync(() => holeKalender(url, strom))).toBe("zu-gross");
  });

  test("Netzwerkfehler und Zeitüberschreitung haben je einen Code, ohne Meldung", async () => {
    const netz = mit(() => {
      throw new TypeError(
        "fetch failed: https://kalender.example.org/ical/geheim-123",
      );
    });
    const fehler = await holeKalender(url, netz).catch((f: LodurFehler) => f);
    expect(fehler).toBeInstanceOf(LodurFehler);
    expect((fehler as LodurFehler).code).toBe("netzwerk");
    expect((fehler as LodurFehler).message).not.toContain("geheim");
    // AbortSignal.timeout bricht mit einem TimeoutError ab
    const langsam = mit(() => {
      throw new DOMException("zu langsam", "TimeoutError");
    });
    expect(await codeAsync(() => holeKalender(url, langsam))).toBe(
      "zeitueberschreitung",
    );
  });
});

describe("Verschlüsselung des Links", () => {
  test("AES-GCM: Rundlauf, kein Klartext, jedes Mal anderer Text", () => {
    const a = verschluessele(GUT, "lodur-link");
    expect(entschluessele(a, "lodur-link")).toBe(GUT);
    expect(a).not.toContain("kalender");
    expect(verschluessele(GUT, "lodur-link")).not.toBe(a);
  });

  test("der Schlüssel hängt am Zweck: Ein Startpasswort-Text öffnet keinen Link", () => {
    expect(entschluessele(verschluessele(GUT, "lodur-link"))).toBeNull();
    expect(
      entschluessele(
        verschluesseleStartpasswort("ABCD-EFGH-JKMN"),
        "lodur-link",
      ),
    ).toBeNull();
    expect(
      entschluesseleStartpasswort(
        verschluesseleStartpasswort("ABCD-EFGH-JKMN"),
      ),
    ).toBe("ABCD-EFGH-JKMN");
  });

  test("verfälschter Text und leere Werte ergeben null", () => {
    const a = verschluessele(GUT, "lodur-link");
    expect(entschluessele(`${a.slice(0, -2)}AA`, "lodur-link")).toBeNull();
    expect(entschluessele(null, "lodur-link")).toBeNull();
    expect(entschluessele("kein-chiffre", "lodur-link")).toBeNull();
  });
});

describe("pruefeAdresse (SR-26)", () => {
  test.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
  ])("%s ist nicht öffentlich", (ip) => {
    expect(istNichtOeffentlich(ip)).toBe(true);
  });

  test.each([
    "93.184.216.34",
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.0.1",
    "2606:2800:21f:cb07:6820:80da:af6b:8b2c",
  ])("%s ist öffentlich", (ip) => {
    expect(istNichtOeffentlich(ip)).toBe(false);
  });

  test("eine einzige interne Adresse oder keine Auflösung genügt zur Ablehnung", async () => {
    await expect(
      pruefeAdresse("h.example.org", async () => ["93.184.216.34"]),
    ).resolves.toBeUndefined();
    for (const adressen of [["93.184.216.34", "127.0.0.1"], []]) {
      expect(
        await codeAsync(() =>
          pruefeAdresse("h.example.org", async () => adressen),
        ),
      ).toBe("url-ungueltig");
    }
    expect(
      await codeAsync(() =>
        pruefeAdresse("h.example.org", async () => {
          throw new Error("ENOTFOUND");
        }),
      ),
    ).toBe("netzwerk");
  });
});

describe("icsAdresse", () => {
  test("macht aus dem membear-Seitenlink den ICS-Link mit demselben Token", () => {
    const seite = new URL(
      "https://www.membear.ch/calendar/kinderfeuerwehr-bezirk-meilen?token=abc-123&lang=de",
    );
    expect(icsAdresse(seite).href).toBe(
      "https://www.membear.ch/api/v1/kinderfeuerwehr-bezirk-meilen/events/calendar?token=abc-123",
    );
  });

  test("lässt jeden anderen Link unverändert", () => {
    for (const text of [
      GUT,
      "https://www.membear.ch/api/v1/x/events/calendar?token=abc",
      "https://kalender.example.org/calendar/x?token=abc",
    ]) {
      const url = new URL(text);
      expect(icsAdresse(url)).toBe(url);
    }
  });
});
