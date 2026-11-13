import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { ladeSeiten } from "../src/seiten.js";
import {
  bereiteAuthTestsVor,
  erstelleTestAuth,
  zufallsIp,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  type PersonaKonto,
  type Welt,
} from "./hilfen/personas.js";

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

const PFAD = "/api/v1/admin/nachrichten";
let welt: Welt;
let admin: PersonaKonto;
let kommando: PersonaKonto;
let stellvertretung: PersonaKonto;
let leitende: PersonaKonto;
let eltern: PersonaKonto;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  admin = await legePersonaAn(welt, "kantonsadmin");
  kommando = await legePersonaAn(welt, "kommandoJfA");
  stellvertretung = await legePersonaAn(welt, "stellvertretung1JfA");
  leitende = await legePersonaAn(welt, "leitendeJfA");
  eltern = await legePersonaAn(welt, "elternJfA");
});

// Jede Anfrage mit eigener Adresse: Das Limit fürs Senden zählt je Adresse
const sende = (body: unknown, konto = admin) =>
  app.request(PFAD, {
    method: "POST",
    headers: {
      ...konto.headers,
      "x-forwarded-for": zufallsIp(),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
const liste = async (konto: PersonaKonto) =>
  (await (await app.request(PFAD, { headers: konto.headers })).json()) as {
    nachrichten: {
      id: string;
      titel: string;
      text: string;
      gelesen?: boolean;
      lesende?: number;
      abgelaufen?: boolean;
    }[];
    empfaenger?: number;
  };
const eintrag = async (konto: PersonaKonto, id: string) =>
  (await liste(konto)).nachrichten.find((n) => n.id === id);
const markiere = (konto: PersonaKonto, id: string) =>
  app.request(`${PFAD}/${id}/gelesen`, {
    method: "PUT",
    headers: konto.headers,
  });
const neu = async (titel = `Hinweis ${randomUUID().slice(0, 8)}`) => {
  const antwort = await sende({ titel, text: "Bitte lesen." });
  expect(antwort.status).toBe(201);
  return { id: ((await antwort.json()) as { id: string }).id, titel };
};

describe("POST /api/v1/admin/nachrichten", () => {
  test("der Kantonsadmin sendet; die Antwort nennt nur ID und Zeiten", async () => {
    const antwort = await sende({ titel: "Wartung", text: "Heute Abend." });
    expect(antwort.status).toBe(201);
    expect(Object.keys(await antwort.json()).sort()).toEqual([
      "erstelltAm",
      "id",
      "laeuftAbAm",
    ]);
  });

  test.each([
    ["ohne Titel", { text: "x" }],
    ["leerer Titel", { titel: "  ", text: "x" }],
    ["Titel mit 81 Zeichen", { titel: "a".repeat(81), text: "x" }],
    ["leerer Text", { titel: "t", text: "" }],
    ["Text mit 1001 Zeichen", { titel: "t", text: "a".repeat(1001) }],
    ["Zeilenumbruch im Titel", { titel: "a\nb", text: "x" }],
    ["Steuerzeichen im Text", { titel: "t", text: "a\u0007b" }],
    [
      "Ablauf in der Vergangenheit",
      { titel: "t", text: "x", laeuftAbAm: "2020-01-01T00:00:00Z" },
    ],
    [
      "Ablauf ohne Zeitzone",
      { titel: "t", text: "x", laeuftAbAm: "2099-01-01" },
    ],
    ["unbekanntes Feld", { titel: "t", text: "x", empfaenger: "alle" }],
  ])("%s ist 400", async (_name, body) => {
    expect((await sende(body)).status).toBe(400);
  });

  test("80 Zeichen Titel, 1000 Zeichen Text und Zeilenumbrüche gehen durch", async () => {
    const antwort = await sende({
      titel: "ä".repeat(80),
      text: `${"b".repeat(998)}\nc`,
      laeuftAbAm: "2099-01-01T00:00:00Z",
    });
    expect(antwort.status).toBe(201);
  });

  test("Kommando, Stellvertretung, Leitende und Eltern dürfen nicht senden (403)", async () => {
    for (const konto of [kommando, stellvertretung, leitende, eltern]) {
      expect((await sende({ titel: "t", text: "x" }, konto)).status).toBe(403);
    }
  });

  test("das Audit-Log hält das Senden fest, nie Titel oder Text", async () => {
    const titel = `Geheim ${randomUUID()}`;
    const antwort = await sende({ titel, text: `Text ${titel}` });
    const { id } = (await antwort.json()) as { id: string };
    const zeilen = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.zielId, id));
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]).toMatchObject({
      akteurId: admin.id,
      aktion: "nachricht_gesendet",
      zielTyp: "nachricht",
      einheitId: null,
    });
    expect(JSON.stringify(zeilen)).not.toContain(titel);
  });

  test("das Senden ist je Adresse begrenzt: die sechste Mitteilung in der Minute ist 429", async () => {
    const ip = zufallsIp();
    const status = [];
    for (let i = 0; i < 6; i++) {
      status.push(
        (
          await app.request(PFAD, {
            method: "POST",
            headers: {
              ...admin.headers,
              "x-forwarded-for": ip,
              "content-type": "application/json",
            },
            body: JSON.stringify({ titel: "t", text: "x" }),
          })
        ).status,
      );
    }
    expect(status).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe("GET /api/v1/admin/nachrichten", () => {
  test("Kommando und Stellvertretung sehen die Mitteilung als ungelesen", async () => {
    const { id } = await neu();
    for (const konto of [kommando, stellvertretung]) {
      expect(await eintrag(konto, id)).toMatchObject({ gelesen: false });
    }
  });

  test("Leitende und Eltern sehen die Liste nicht (403)", async () => {
    for (const konto of [leitende, eltern]) {
      expect((await app.request(PFAD, { headers: konto.headers })).status).toBe(
        403,
      );
    }
  });

  test("ohne Sitzung 401", async () => {
    expect((await app.request(PFAD)).status).toBe(401);
  });

  test("eine abgelaufene Mitteilung fehlt in der Glocke, der Kantonsadmin sieht sie als abgelaufen", async () => {
    const { id } = await neu();
    await db
      .update(schema.nachricht)
      .set({ laeuftAbAm: new Date(Date.now() - 60_000) })
      .where(eq(schema.nachricht.id, id));
    expect(await eintrag(kommando, id)).toBeUndefined();
    expect(await eintrag(admin, id)).toMatchObject({ abgelaufen: true });
    expect((await markiere(kommando, id)).status).toBe(404);
  });

  test("eine Mitteilung mit Ablauf in der Zukunft bleibt sichtbar", async () => {
    const antwort = await sende({
      titel: `Mit Ablauf ${randomUUID().slice(0, 8)}`,
      text: "x",
      laeuftAbAm: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const { id } = (await antwort.json()) as { id: string };
    expect(await eintrag(kommando, id)).toBeDefined();
    expect(await eintrag(admin, id)).toMatchObject({ abgelaufen: false });
  });
});

describe("Gelesen", () => {
  test("jedes Konto markiert für sich; der Kantonsadmin sieht nur die Zahl, nie die Konten", async () => {
    const { id } = await neu();
    expect(await eintrag(admin, id)).toMatchObject({ lesende: 0 });

    expect((await markiere(kommando, id)).status).toBe(204);
    expect(await eintrag(kommando, id)).toMatchObject({ gelesen: true });
    expect(await eintrag(stellvertretung, id)).toMatchObject({
      gelesen: false,
    });
    expect(await eintrag(admin, id)).toMatchObject({ lesende: 1 });

    // Zweimal markieren zählt einmal
    expect((await markiere(kommando, id)).status).toBe(204);
    expect((await markiere(stellvertretung, id)).status).toBe(204);
    expect(await eintrag(admin, id)).toMatchObject({ lesende: 2 });

    const roh = JSON.stringify(await liste(admin));
    for (const konto of [kommando, stellvertretung]) {
      expect(roh).not.toContain(konto.id);
      expect(roh).not.toContain(konto.benutzername);
    }
    expect((await liste(admin)).empfaenger).toBeGreaterThanOrEqual(2);
  });

  test("Kantonsadmin, Leitende und Eltern markieren nichts (403), eine fremde ID ist 404, eine Nicht-UUID 400", async () => {
    const { id } = await neu();
    for (const konto of [admin, leitende, eltern]) {
      expect((await markiere(konto, id)).status).toBe(403);
    }
    expect((await markiere(kommando, randomUUID())).status).toBe(404);
    expect((await markiere(kommando, "gelesen")).status).toBe(400);
  });

  test("«alle gelesen» markiert alle sichtbaren Mitteilungen des Kontos, nicht die der anderen", async () => {
    const a = await neu();
    const b = await neu();
    const abgelaufen = await neu();
    await db
      .update(schema.nachricht)
      .set({ laeuftAbAm: new Date(Date.now() - 60_000) })
      .where(eq(schema.nachricht.id, abgelaufen.id));

    const antwort = await app.request(`${PFAD}/gelesen`, {
      method: "POST",
      headers: stellvertretung.headers,
    });
    expect(antwort.status).toBe(204);
    for (const n of [a, b]) {
      expect(await eintrag(stellvertretung, n.id)).toMatchObject({
        gelesen: true,
      });
      expect(await eintrag(kommando, n.id)).toMatchObject({ gelesen: false });
    }
    // Zweimal ist harmlos; die abgelaufene bekommt keine Marke
    expect(
      (
        await app.request(`${PFAD}/gelesen`, {
          method: "POST",
          headers: stellvertretung.headers,
        })
      ).status,
    ).toBe(204);
    const marken = await db
      .select()
      .from(schema.nachrichtGelesen)
      .where(eq(schema.nachrichtGelesen.nachrichtId, abgelaufen.id));
    expect(marken).toHaveLength(0);
  });

  test("«alle gelesen» ist für Kantonsadmin und Eltern 403", async () => {
    for (const konto of [admin, eltern]) {
      expect(
        (
          await app.request(`${PFAD}/gelesen`, {
            method: "POST",
            headers: konto.headers,
          })
        ).status,
      ).toBe(403);
    }
  });
});

describe("DELETE /api/v1/admin/nachrichten/:id", () => {
  test("der Kantonsadmin zieht zurück: weg aus der Glocke, die Lesemarken gehen mit, das Audit-Log bleibt ohne Text", async () => {
    const { id, titel } = await neu();
    await markiere(kommando, id);
    const antwort = await app.request(`${PFAD}/${id}`, {
      method: "DELETE",
      headers: admin.headers,
    });
    expect(antwort.status).toBe(204);
    expect(await eintrag(kommando, id)).toBeUndefined();
    expect(await eintrag(admin, id)).toBeUndefined();
    expect(
      await db
        .select()
        .from(schema.nachrichtGelesen)
        .where(eq(schema.nachrichtGelesen.nachrichtId, id)),
    ).toHaveLength(0);
    const protokoll = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.zielId, id),
          eq(schema.auditLog.aktion, "nachricht_zurueckgezogen"),
        ),
      );
    expect(protokoll).toHaveLength(1);
    expect(protokoll[0]).toMatchObject({ akteurId: admin.id });
    expect(JSON.stringify(protokoll)).not.toContain(titel);
    // Ein zweites Mal gibt es sie nicht mehr
    expect(
      (
        await app.request(`${PFAD}/${id}`, {
          method: "DELETE",
          headers: admin.headers,
        })
      ).status,
    ).toBe(404);
  });

  test("Kommando, Stellvertretung, Leitende und Eltern ziehen nichts zurück (403)", async () => {
    const { id } = await neu();
    for (const konto of [kommando, stellvertretung, leitende, eltern]) {
      expect(
        (
          await app.request(`${PFAD}/${id}`, {
            method: "DELETE",
            headers: konto.headers,
          })
        ).status,
      ).toBe(403);
    }
    expect(await eintrag(kommando, id)).toBeDefined();
  });
});
