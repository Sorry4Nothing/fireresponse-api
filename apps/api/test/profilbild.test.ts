import { eq } from "drizzle-orm";
import postgres from "postgres";
import sharp from "sharp";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";
import { erstelleApp } from "../src/app.js";
import { BILD_MAX_BYTES } from "../src/bild.js";
import { kodiereProfilbild } from "../src/bild-sharp.js";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { ladeSeiten } from "../src/seiten.js";
import { bereiteAuthTestsVor, erstelleTestAuth } from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  type Persona,
  type PersonaKonto,
  type Welt,
} from "./hilfen/personas.js";
import { legeProgrammAn } from "./hilfen/programme.js";

bereiteAuthTestsVor();

const sql = postgres(API_URL);
const db = erstelleDb(sql);
const auth = erstelleTestAuth(db);
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  kodiereBild: kodiereProfilbild,
  seiten: ladeSeiten(),
});
afterAll(() => sql.end());

let welt: Welt;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
});

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

// Nur synthetische Bilder: einfarbig, nie ein Foto einer echten Person
const jpeg = (breite = 600, hoehe = 400) =>
  sharp({
    create: {
      width: breite,
      height: hoehe,
      channels: 3,
      background: "#3366cc",
    },
  })
    .jpeg()
    .toBuffer();

const person = (p: Persona) => legePersonaAn(welt, p);

const hochladen = (konto: PersonaKonto, body: Uint8Array) =>
  app.request("/api/v1/ich/bild", {
    method: "PUT",
    headers: { ...konto.headers, "content-type": "image/jpeg" },
    body: body as BodyInit,
  });

const holen = (konto: PersonaKonto, id: string | null) =>
  app.request(`/api/v1/personen/${id}/bild`, { headers: konto.headers });

const loeschen = (konto: PersonaKonto) =>
  app.request("/api/v1/ich/bild", { method: "DELETE", headers: konto.headers });

const profil = async (konto: PersonaKonto) =>
  (await (
    await app.request("/api/v1/ich", { headers: konto.headers })
  ).json()) as { bildUrl: string | null };

const zeilen = (id: string | null) =>
  db
    .select({ id: schema.profilbild.userId })
    .from(schema.profilbild)
    .where(eq(schema.profilbild.userId, id as string));

const pfadVon = (id: string | null) =>
  new RegExp(`^/api/v1/personen/${id}/bild\\?v=\\d+$`);

describe("PUT /api/v1/ich/bild", () => {
  test("speichert das Bild als 256 × 256 JPEG ohne EXIF und Ortsdaten", async () => {
    const konto = await person("elternJfA");
    const mitExif = await sharp(await jpeg())
      .withExif({
        IFD0: { ImageDescription: "GEHEIME-BESCHREIBUNG" },
        IFD3: { GPSLatitudeRef: "N", GPSLongitudeRef: "E" },
      })
      .jpeg()
      .toBuffer();
    // Der Test beweist sich selbst: Die Eingabe trägt die Daten wirklich
    expect(mitExif.includes("GEHEIME-BESCHREIBUNG")).toBe(true);

    expect((await hochladen(konto, mitExif)).status).toBe(204);

    const res = await holen(konto, konto.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const bild = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(bild).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 256, 256]);
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(bild.includes("GEHEIME-BESCHREIBUNG")).toBe(false);
    expect(bild.length).toBeLessThan(50_000);
  });

  test("PNG mit Transparenz und WebP werden angenommen und als JPEG gespeichert", async () => {
    const konto = await person("elternJfA");
    const png = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const webp = await sharp(await jpeg())
      .webp()
      .toBuffer();
    for (const bild of [png, webp]) {
      expect((await hochladen(konto, bild)).status).toBe(204);
      const meta = await sharp(
        Buffer.from(await (await holen(konto, konto.id)).arrayBuffer()),
      ).metadata();
      expect(meta.format).toBe("jpeg");
    }
  });

  test("ein zweiter Upload ersetzt das Bild: eine Zeile, neuer Pfad", async () => {
    const konto = await person("elternJfA");
    await hochladen(konto, await jpeg());
    const vorher = await profil(konto);
    await new Promise((r) => setTimeout(r, 20));
    await hochladen(konto, await jpeg(100, 100));
    const nachher = await profil(konto);
    expect(await zeilen(konto.id)).toHaveLength(1);
    expect(vorher.bildUrl).toMatch(pfadVon(konto.id));
    expect(nachher.bildUrl).toMatch(pfadVon(konto.id));
    expect(nachher.bildUrl).not.toBe(vorher.bildUrl);
  });

  test.each([
    ["SVG", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ["GIF", "GIF89a\u0001\u0000\u0001\u0000"],
    ["PDF", "%PDF-1.4 ..."],
    ["Text", "Das ist kein Bild"],
    ["leer", ""],
  ])(
    "%s wird nicht gespeichert (415), auch mit image/jpeg als Content-Type",
    async (_name, inhalt) => {
      const konto = await person("elternJfA");
      const res = await hochladen(konto, Buffer.from(inhalt));
      expect(res.status).toBe(415);
      expect(await res.json()).toMatchObject({ code: "BILD_FORMAT" });
      expect(await zeilen(konto.id)).toHaveLength(0);
    },
  );

  test("gültige Kennung, aber kein lesbares Bild: 415", async () => {
    const konto = await person("elternJfA");
    const kaputt = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from("kein jpeg, nur der Anfang stimmt"),
    ]);
    expect((await hochladen(konto, kaputt)).status).toBe(415);
    expect(await zeilen(konto.id)).toHaveLength(0);
  });

  test("ein Bild mit zu vielen Pixeln wird abgelehnt (Dekompressionsbombe)", async () => {
    const konto = await person("elternJfA");
    // 64 Mio. Pixel, als PNG wenige hundert KB
    const bombe = await sharp({
      create: { width: 8000, height: 8000, channels: 3, background: "#fff" },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bombe.length).toBeLessThan(BILD_MAX_BYTES);
    expect((await hochladen(konto, bombe)).status).toBe(415);
    expect(await zeilen(konto.id)).toHaveLength(0);
  });

  test("über 5 MB: 413, mit Content-Length schon vor dem Einlesen, ohne beim Lesen des Streams", async () => {
    const konto = await person("elternJfA");
    const gross = Buffer.alloc(BILD_MAX_BYTES + 1, 0xff);
    const mitLaenge = await app.request("/api/v1/ich/bild", {
      method: "PUT",
      headers: { ...konto.headers, "content-length": String(gross.length) },
      body: gross,
    });
    expect(mitLaenge.status).toBe(413);
    const ohneLaenge = await hochladen(konto, gross);
    expect(ohneLaenge.status).toBe(413);
    expect(await ohneLaenge.json()).toEqual({
      code: "ZU_GROSS",
      message: "Anfrage zu gross",
    });
    expect(await zeilen(konto.id)).toHaveLength(0);
  });

  test("die Grenze von 64 KB gilt weiter für alle anderen Routen", async () => {
    const konto = await person("elternJfA");
    const res = await app.request("/api/v1/ich", {
      method: "PATCH",
      headers: { ...konto.headers, "content-type": "application/json" },
      body: JSON.stringify({ telefon: "1".repeat(70_000) }),
    });
    expect(res.status).toBe(413);
  });

  test("Rate-Limit: ab dem elften Upload in zehn Minuten 429, auch fehlgeschlagene zählen", async () => {
    const konto = await person("elternJfA");
    const status: number[] = [];
    for (let i = 0; i < 11; i++) {
      status.push((await hochladen(konto, Buffer.from("x"))).status);
    }
    expect(status).toEqual([...Array(10).fill(415), 429]);
    // Eine andere Person ist nicht betroffen
    const andere = await person("elternJfA");
    expect((await hochladen(andere, await jpeg())).status).toBe(204);
  });
});

describe("DELETE /api/v1/ich/bild und Löschen mit dem Konto", () => {
  test("die Person löscht ihr Bild jederzeit; ein zweites Mal ist auch 204", async () => {
    const konto = await person("elternJfA");
    await hochladen(konto, await jpeg());
    expect((await loeschen(konto)).status).toBe(204);
    expect(await zeilen(konto.id)).toHaveLength(0);
    expect((await holen(konto, konto.id)).status).toBe(404);
    expect((await profil(konto)).bildUrl).toBeNull();
    expect((await loeschen(konto)).status).toBe(204);
  });

  test("DELETE trifft nur das eigene Bild", async () => {
    const [a, b] = await Promise.all([
      person("elternJfA"),
      person("elternJfA"),
    ]);
    await hochladen(a, await jpeg());
    await hochladen(b, await jpeg());
    await loeschen(a);
    expect(await zeilen(a.id)).toHaveLength(0);
    expect(await zeilen(b.id)).toHaveLength(1);
  });

  test("verschwindet das Konto auf anderem Weg (Fremdschlüssel), geht das Bild mit", async () => {
    const ziel = await person("elternJfA");
    await hochladen(ziel, await jpeg());
    await db.delete(schema.user).where(eq(schema.user.id, ziel.id as string));
    expect(await zeilen(ziel.id)).toHaveLength(0);
  });
});

describe("Ohne Sitzung", () => {
  test("Hochladen, Löschen und Abrufen verlangen eine Sitzung (401), auch für ein vorhandenes Bild", async () => {
    const konto = await person("elternJfA");
    await hochladen(konto, await jpeg());
    const ohne = await person("ohneLogin");
    expect((await hochladen(ohne, await jpeg())).status).toBe(401);
    expect((await loeschen(ohne)).status).toBe(401);
    expect((await holen(ohne, konto.id)).status).toBe(401);
    // Auch ganz ohne Header
    expect(
      (await app.request(`/api/v1/personen/${konto.id}/bild`)).status,
    ).toBe(401);
    expect(await zeilen(konto.id)).toHaveLength(1);
  });

  test("ein deaktiviertes Konto sieht nichts (401)", async () => {
    const [ziel, weg] = await Promise.all([
      person("elternJfA"),
      person("deaktiviert"),
    ]);
    await hochladen(ziel, await jpeg());
    expect((await holen(weg, ziel.id)).status).toBe(401);
  });
});

describe("GET /api/v1/personen/:id/bild: wer es sieht", () => {
  test("Header: private, no-store und nosniff", async () => {
    const konto = await person("elternJfA");
    await hochladen(konto, await jpeg());
    const res = await holen(konto, konto.id);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // Auch die Ablehnung trägt no-store
    const fremd = await person("kommandoKfA");
    const nein = await holen(fremd, konto.id);
    expect(nein.status).toBe(404);
    expect(nein.headers.get("cache-control")).toBe("private, no-store");
  });

  test("das Kommando sieht, wer die Einheit kennt; Fremde nichts", async () => {
    const [kommando, admin, leitende, eltern, selbst, elternAundB] =
      await Promise.all([
        person("kommandoJfA"),
        person("kantonsadmin"),
        person("leitendeJfA"),
        person("elternJfA"),
        person("teilnehmendeSelbstJfA"),
        person("elternAundB"),
      ]);
    const [kfKommando, bKommando, elternKf] = await Promise.all([
      person("kommandoKfA"),
      person("kommandoJfB"),
      person("elternKfA"),
    ]);
    await hochladen(kommando, await jpeg());
    const status = async (konten: PersonaKonto[]) =>
      Promise.all(
        konten.map(async (k) => (await holen(k, kommando.id)).status),
      );
    expect(
      await status([kommando, admin, leitende, eltern, selbst, elternAundB]),
    ).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await status([kfKommando, bKommando, elternKf])).toEqual([
      404, 404, 404,
    ]);
    // Unbekannte Person und Person ohne Bild: dieselbe Antwort
    expect(
      (await holen(eltern, "0198f0a0-0000-7000-8000-000000000000")).status,
    ).toBe(404);
    expect((await holen(kfKommando, eltern.id)).status).toBe(404);
    expect((await holen(eltern, "kein-uuid")).status).toBe(400);
  });

  test("Leitende sieht nur, wer selbst eine Rolle in der Einheit hat; Eltern und Teilnehmende sehen nur das Kommando", async () => {
    const [leitende, kollege, stv, eltern, kfKommando] = await Promise.all([
      person("leitendeJfA"),
      person("leitendeJfA"),
      person("stellvertretung1JfA"),
      person("elternJfA"),
      person("kommandoKfA"),
    ]);
    await hochladen(leitende, await jpeg());
    for (const k of [kollege, stv]) {
      expect((await holen(k, leitende.id)).status).toBe(200);
    }
    for (const k of [eltern, kfKommando]) {
      expect((await holen(k, leitende.id)).status).toBe(404);
    }
    // Die Stellvertretung ist Kontakt: Eltern sehen ihr Bild
    await hochladen(stv, await jpeg());
    expect((await holen(eltern, stv.id)).status).toBe(200);
  });

  test("Kantonsadmin sieht das Bild jeder Person, ein Konto ohne Rolle sonst keines", async () => {
    const [admin, eltern, anderer] = await Promise.all([
      person("kantonsadmin"),
      person("elternJfA"),
      person("elternAundB"),
    ]);
    await hochladen(eltern, await jpeg());
    expect((await holen(admin, eltern.id)).status).toBe(200);
    expect((await holen(anderer, eltern.id)).status).toBe(404);
  });

  test("die Verwaltung holt das Bild unter /admin/ auch ohne Einwilligung in die App", async () => {
    const [kommando, ohne] = await Promise.all([
      person("kommandoJfA"),
      person("ohneEinwilligung"),
    ]);
    await hochladen(kommando, await jpeg());
    expect((await holen(ohne, kommando.id)).status).toBe(403);
    const res = await app.request(
      `/api/v1/admin/personen/${kommando.id}/bild`,
      {
        headers: ohne.headers,
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    // Dieselbe Sichtbarkeit: Wer die Person nicht kennt, bekommt 404
    const fremd = await person("kommandoKfA");
    expect(
      (
        await app.request(`/api/v1/admin/personen/${kommando.id}/bild`, {
          headers: fremd.headers,
        })
      ).status,
    ).toBe(404);
  });

  test("die Liste der Anmeldungen trägt bildUrl der Leitenden", async () => {
    const [kommando, leitende] = await Promise.all([
      person("kommandoJfA"),
      person("leitendeJfA"),
    ]);
    await hochladen(leitende, await jpeg());
    const programm = await legeProgrammAn(db, {
      einheitId: welt.einheit.jfA,
    });
    const bildUrlVon = async () => {
      const { leitende: liste } = (await (
        await app.request(`/api/v1/programme/${programm.id}/teilnahmen`, {
          headers: kommando.headers,
        })
      ).json()) as { leitende: { id: string; bildUrl: string | null }[] };
      return liste.find((l) => l.id === leitende.id)?.bildUrl;
    };
    expect(await bildUrlVon()).toMatch(pfadVon(leitende.id));
    await loeschen(leitende);
    expect(await bildUrlVon()).toBeNull();
  });
});
