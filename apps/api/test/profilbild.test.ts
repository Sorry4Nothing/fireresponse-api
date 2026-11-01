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
    const konto = await person("elternA");
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
    const konto = await person("elternA");
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
    const konto = await person("elternA");
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
      const konto = await person("elternA");
      const res = await hochladen(konto, Buffer.from(inhalt));
      expect(res.status).toBe(415);
      expect(await res.json()).toMatchObject({ code: "BILD_FORMAT" });
      expect(await zeilen(konto.id)).toHaveLength(0);
    },
  );

  test("gültige Kennung, aber kein lesbares Bild: 415", async () => {
    const konto = await person("elternA");
    const kaputt = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from("kein jpeg, nur der Anfang stimmt"),
    ]);
    expect((await hochladen(konto, kaputt)).status).toBe(415);
    expect(await zeilen(konto.id)).toHaveLength(0);
  });

  test("ein Bild mit zu vielen Pixeln wird abgelehnt (Dekompressionsbombe)", async () => {
    const konto = await person("elternA");
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
    const konto = await person("elternA");
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
    const konto = await person("elternA");
    const res = await app.request("/api/v1/ich", {
      method: "PATCH",
      headers: { ...konto.headers, "content-type": "application/json" },
      body: JSON.stringify({ telefon: "1".repeat(70_000) }),
    });
    expect(res.status).toBe(413);
  });

  test("Rate-Limit: ab dem elften Upload in zehn Minuten 429, auch fehlgeschlagene zählen", async () => {
    const konto = await person("elternA");
    const status: number[] = [];
    for (let i = 0; i < 11; i++) {
      status.push((await hochladen(konto, Buffer.from("x"))).status);
    }
    expect(status).toEqual([...Array(10).fill(415), 429]);
    // Eine andere Person ist nicht betroffen
    const andere = await person("elternA");
    expect((await hochladen(andere, await jpeg())).status).toBe(204);
  });
});

describe("DELETE /api/v1/ich/bild und Löschen mit dem Konto", () => {
  test("die Person löscht ihr Bild jederzeit; ein zweites Mal ist auch 204", async () => {
    const konto = await person("elternA");
    await hochladen(konto, await jpeg());
    expect((await loeschen(konto)).status).toBe(204);
    expect(await zeilen(konto.id)).toHaveLength(0);
    expect((await holen(konto, konto.id)).status).toBe(404);
    expect((await profil(konto)).bildUrl).toBeNull();
    expect((await loeschen(konto)).status).toBe(204);
  });

  test("DELETE trifft nur das eigene Bild", async () => {
    const [a, b] = await Promise.all([person("elternA"), person("elternA")]);
    await hochladen(a, await jpeg());
    await hochladen(b, await jpeg());
    await loeschen(a);
    expect(await zeilen(a.id)).toHaveLength(0);
    expect(await zeilen(b.id)).toHaveLength(1);
  });

  test("löscht ein Admin die Person, geht das Bild mit", async () => {
    const [admin, ziel] = await Promise.all([
      person("admin"),
      person("elternA"),
    ]);
    await hochladen(ziel, await jpeg());
    expect(await zeilen(ziel.id)).toHaveLength(1);
    const res = await app.request(`/api/v1/admin/personen/${ziel.id}`, {
      method: "DELETE",
      headers: admin.headers,
    });
    expect(res.status).toBe(204);
    expect(await zeilen(ziel.id)).toHaveLength(0);
  });

  test("deaktiviert ein Admin die Person, geht das Bild mit; Aktivieren bringt es nicht zurück", async () => {
    const [admin, ziel, leser] = await Promise.all([
      person("admin"),
      person("slA"),
      person("elternA"),
    ]);
    await hochladen(ziel, await jpeg());
    expect((await holen(leser, ziel.id)).status).toBe(200);
    const admin_ = (aktion: string) =>
      app.request(`/api/v1/admin/personen/${ziel.id}/${aktion}`, {
        method: "POST",
        headers: admin.headers,
      });
    expect((await admin_("deaktivieren")).status).toBe(204);
    expect(await zeilen(ziel.id)).toHaveLength(0);
    expect((await holen(leser, ziel.id)).status).toBe(404);
    expect((await admin_("aktivieren")).status).toBe(204);
    expect((await holen(leser, ziel.id)).status).toBe(404);
    // bildUrl ist null: in den Kontakten der Stufe und im eigenen Profil
    const { kontakte } = (await (
      await app.request(`/api/v1/stufen/${welt.stufeAId}/kontakte`, {
        headers: leser.headers,
      })
    ).json()) as { kontakte: { id: string; bildUrl: string | null }[] };
    expect(kontakte.find((k) => k.id === ziel.id)?.bildUrl).toBeNull();
  });

  test("verschwindet das Konto auf anderem Weg (Fremdschlüssel), geht das Bild mit", async () => {
    const ziel = await person("elternA");
    await hochladen(ziel, await jpeg());
    await db.delete(schema.user).where(eq(schema.user.id, ziel.id as string));
    expect(await zeilen(ziel.id)).toHaveLength(0);
  });
});

describe("Ohne Sitzung", () => {
  test("Hochladen, Löschen und Abrufen verlangen eine Sitzung (401), auch für ein vorhandenes Bild", async () => {
    const konto = await person("elternA");
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
      person("elternA"),
      person("deaktiviert"),
    ]);
    await hochladen(ziel, await jpeg());
    expect((await holen(weg, ziel.id)).status).toBe(401);
  });
});

describe("GET /api/v1/personen/:id/bild: wer es sieht", () => {
  test("Header: private, no-store und nosniff", async () => {
    const konto = await person("elternA");
    await hochladen(konto, await jpeg());
    const res = await holen(konto, konto.id);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // Auch die Ablehnung trägt no-store
    const fremd = await person("slB");
    const nein = await holen(fremd, konto.id);
    expect(nein.status).toBe(404);
    expect(nein.headers.get("cache-control")).toBe("private, no-store");
  });

  test("die SL sehen Eltern ihrer Stufe, Admin und Leitende der Stufe sehen die SL, Fremde nichts", async () => {
    const [slA, admin, leitendeA, elternA, slB, leitendeB, elternB, demo] =
      await Promise.all([
        person("slA"),
        person("admin"),
        person("leitendeA"),
        person("elternA"),
        person("slB"),
        person("leitendeB"),
        person("elternB"),
        person("demoEltern"),
      ]);
    await hochladen(slA, await jpeg());
    const status = async (konten: PersonaKonto[]) =>
      Promise.all(konten.map(async (k) => (await holen(k, slA.id)).status));
    expect(await status([admin, leitendeA, elternA, slA])).toEqual([
      200, 200, 200, 200,
    ]);
    expect(await status([slB, leitendeB, elternB, demo])).toEqual([
      404, 404, 404, 404,
    ]);
    // Unbekannte Person und Person ohne Bild: dieselbe Antwort
    expect(
      (await holen(elternA, "0198f0a0-0000-7000-8000-000000000000")).status,
    ).toBe(404);
    expect((await holen(slB, elternB.id)).status).toBe(404);
    expect((await holen(elternA, "kein-uuid")).status).toBe(400);
  });

  test("Admin sieht das Bild jeder Person der eigenen Abteilung, die Admin einer anderen Abteilung keines", async () => {
    const [admin, eltern, demoAdmin] = await Promise.all([
      person("admin"),
      person("elternA"),
      person("demoAdmin"),
    ]);
    await hochladen(eltern, await jpeg());
    expect((await holen(admin, eltern.id)).status).toBe(200);
    expect((await holen(demoAdmin, eltern.id)).status).toBe(404);
    // Die Liste der Verwaltung trägt den Pfad zum Bild, ohne Bild null
    const liste = async () =>
      (
        (await (
          await app.request("/api/v1/admin/personen", {
            headers: admin.headers,
          })
        ).json()) as { personen: { id: string; bildUrl: string | null }[] }
      ).personen.find((p) => p.id === eltern.id)!.bildUrl;
    expect(await liste()).toMatch(pfadVon(eltern.id));
    await loeschen(eltern);
    expect(await liste()).toBeNull();
  });

  test("die Kontakte eines Programms zeigen die SL mit Status Ja; wer das Programm sieht, sieht ihr Bild", async () => {
    const [sl, fremdeSl] = await Promise.all([person("slA"), person("slB")]);
    await hochladen(sl, await jpeg());
    expect((await holen(fremdeSl, sl.id)).status).toBe(404);
    const programm = await legeProgrammAn(db, {
      abteilungId: welt.testabteilungId,
      sichtbarkeit: "eltern",
      stufen: [welt.stufeAId],
    });
    const anmelden = (status: "ja" | "nein") =>
      db
        .insert(schema.leitungAnmeldung)
        .values({ programmId: programm.id, userId: sl.id as string, status })
        .onConflictDoUpdate({
          target: [
            schema.leitungAnmeldung.programmId,
            schema.leitungAnmeldung.userId,
          ],
          set: { status },
        });
    // Die Kontakte nennen nur den Hauptkontakt je Stufe; weitere SL der Stufe stehen ohne Priorität dahinter
    await db
      .update(schema.rolle)
      .set({ prioritaet: 1 })
      .where(eq(schema.rolle.userId, sl.id as string));
    await anmelden("nein");
    expect((await holen(fremdeSl, sl.id)).status).toBe(404);
    await anmelden("ja");
    expect((await holen(fremdeSl, sl.id)).status).toBe(200);
    const { kontakte } = (await (
      await app.request(`/api/v1/programme/${programm.id}/kontakte`, {
        headers: fremdeSl.headers,
      })
    ).json()) as { kontakte: { id: string; bildUrl: string | null }[] };
    expect(kontakte.find((k) => k.id === sl.id)?.bildUrl).toMatch(
      pfadVon(sl.id),
    );
  });

  test("Leitende der Stufe sehen das Bild ihrer Kolleginnen und der SL; die Anmeldungen tragen bildUrl", async () => {
    const [leitende, kollege, sl, eltern, fremdeSl, fremdeLeitende] =
      await Promise.all([
        person("leitendeA"),
        person("leitendeA"),
        person("slA"),
        person("elternA"),
        person("slB"),
        person("leitendeB"),
      ]);
    await hochladen(leitende, await jpeg());
    for (const k of [kollege, sl]) {
      expect((await holen(k, leitende.id)).status).toBe(200);
    }
    for (const k of [eltern, fremdeSl, fremdeLeitende]) {
      expect((await holen(k, leitende.id)).status).toBe(404);
    }
    const programm = await legeProgrammAn(db, {
      abteilungId: welt.testabteilungId,
      sichtbarkeit: "leitende",
      stufen: [welt.stufeAId],
    });
    const bildUrlVon = async (betrachter: PersonaKonto) => {
      const { leitende: liste } = (await (
        await app.request(`/api/v1/programme/${programm.id}/teilnahmen`, {
          headers: betrachter.headers,
        })
      ).json()) as { leitende: { id: string; bildUrl: string | null }[] };
      return liste.find((l) => l.id === leitende.id)?.bildUrl;
    };
    expect(await bildUrlVon(sl)).toMatch(pfadVon(leitende.id));
    await loeschen(leitende);
    expect(await bildUrlVon(sl)).toBeNull();
  });
});

describe("bildUrl in Kontakten", () => {
  test("bildUrl bei den Kontakten der Stufe", async () => {
    const [sl, eltern] = await Promise.all([person("slA"), person("elternA")]);
    await hochladen(sl, await jpeg());
    const lies = async () =>
      (
        (await (
          await app.request(`/api/v1/stufen/${welt.stufeAId}/kontakte`, {
            headers: eltern.headers,
          })
        ).json()) as { kontakte: { id: string; bildUrl: string | null }[] }
      ).kontakte.find((k) => k.id === sl.id);
    expect((await lies())?.bildUrl).toMatch(pfadVon(sl.id));
    await loeschen(sl);
    expect((await lies())?.bildUrl).toBeNull();
  });
});
