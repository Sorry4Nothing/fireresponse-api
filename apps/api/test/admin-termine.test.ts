import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { TokenMessage } from "firebase-admin/messaging";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import type { Fcm } from "../src/push.js";
import { ladeSeiten } from "../src/seiten.js";
import { bereiteAuthTestsVor, erstelleTestAuth } from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
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
  seiten: ladeSeiten(),
});
afterAll(() => sql.end());

let welt: Welt;
let kommando: PersonaKonto;
let eigener: string;
let fremder: string;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  kommando = await legePersonaAn(welt, "kommandoJfA");
  const jetzt = new Date("2031-05-01T18:00:00Z");
  eigener = (
    await legeProgrammAn(db, {
      einheitId: welt.einheit.jfA,
      titel: "Übung 1",
      beginn: jetzt,
    })
  ).id;
  await legeProgrammAn(db, {
    einheitId: welt.einheit.jfA,
    titel: "Zu spät",
    beginn: new Date("2032-05-01T18:00:00Z"),
  });
  fremder = (
    await legeProgrammAn(db, {
      einheitId: welt.einheit.kfA,
      beginn: jetzt,
    })
  ).id;
});

const basis = () => `/api/v1/admin/einheiten/${welt.einheit.jfA}/termine`;
const setze = (id: string, body: unknown, einheitId = welt.einheit.jfA) =>
  app.request(`/api/v1/admin/einheiten/${einheitId}/termine/${id}`, {
    method: "PUT",
    headers: { ...kommando.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const nurLeitende = async (id: string) =>
  (
    await db
      .select({ n: schema.programm.nurLeitende })
      .from(schema.programm)
      .where(eq(schema.programm.id, id))
  )[0]!.n;

describe("GET …/termine", () => {
  test("listet die Termine des Zeitraums mit Art und Schalter", async () => {
    const res = await app.request(`${basis()}?von=2031-01-01&bis=2031-12-31`, {
      headers: kommando.headers,
    });
    expect(res.status).toBe(200);
    const { termine } = (await res.json()) as {
      termine: { id: string; titel: string; nurLeitende: boolean }[];
    };
    expect(termine).toHaveLength(1);
    expect(termine[0]).toMatchObject({
      id: eigener,
      titel: "Übung 1",
      art: "Übung",
      nurLeitende: false,
    });
  });

  test("ohne oder mit ungültigem Zeitraum: 400", async () => {
    for (const q of ["", "?von=2031-01-01", "?von=x&bis=y"]) {
      const res = await app.request(`${basis()}${q}`, {
        headers: kommando.headers,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("PUT …/termine/:id", () => {
  test("setzt den Schalter und schreibt einen Audit-Eintrag; gleicher Wert ändert nichts", async () => {
    const audit = () =>
      db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.zielId, eigener));
    expect((await setze(eigener, { nurLeitende: true })).status).toBe(200);
    expect(await nurLeitende(eigener)).toBe(true);
    expect(await audit()).toHaveLength(1);
    expect((await setze(eigener, { nurLeitende: true })).status).toBe(200);
    expect(await audit()).toHaveLength(1);
    expect((await setze(eigener, { nurLeitende: false })).status).toBe(200);
    expect(await nurLeitende(eigener)).toBe(false);
  });

  test("Termin einer anderen Einheit: 404, unverändert", async () => {
    expect((await setze(fremder, { nurLeitende: true })).status).toBe(404);
    expect(await nurLeitende(fremder)).toBe(false);
  });

  test("fremde Felder und falsche Typen: 400", async () => {
    expect((await setze(eigener, { gibtEsNicht: "x" })).status).toBe(400);
    expect((await setze(eigener, { nurLeitende: "ja" })).status).toBe(400);
    expect((await setze(eigener, {})).status).toBe(400);
  });

  test("Termin aus Lodur: Titel und Zeit gehören dem Sync (409), der Schalter nicht", async () => {
    const res = await setze(eigener, { titel: "Neu" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "TERMIN_AUS_LODUR" });
    const [zeile] = await db
      .select({ titel: schema.programm.titel })
      .from(schema.programm)
      .where(eq(schema.programm.id, eigener));
    expect(zeile!.titel).toBe("Übung 1");
  });
});

// Termine ohne Lodur-Link: Quelle «manuell», der Sync fasst sie nie an
const manuell = {
  titel: "Atemschutz-Übung",
  ganztaegig: false,
  beginn: "2031-06-10T18:30",
  ende: "2031-06-10T20:30",
};
const sende = (
  methode: "POST" | "PUT" | "DELETE",
  pfad: string,
  body?: unknown,
  einheitId = welt.einheit.jfA,
) =>
  app.request(`/api/v1/admin/einheiten/${einheitId}/termine${pfad}`, {
    method: methode,
    headers: { ...kommando.headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const lege = async (body: Record<string, unknown> = {}) => {
  const res = await sende("POST", "", { ...manuell, ...body });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    id: string;
    titel: string;
    quelle: string;
    beginn: string | null;
    nurLeitende: boolean;
  };
};
const zeile = async (id: string) =>
  (
    await db.select().from(schema.programm).where(eq(schema.programm.id, id))
  )[0];

describe("POST …/termine", () => {
  test("legt einen manuellen Termin an: Schweizer Zeit, Quelle, Audit-Eintrag", async () => {
    const termin = await lege({
      art: "Übung",
      ort: "Magazin",
      thema: "Atemschutz",
      info: "Handschuhe",
      aufgebot: "18:00 im Magazin",
      nurLeitende: true,
    });
    // Sommerzeit: 18:30 in Zürich ist 16:30 UTC
    expect(termin).toMatchObject({
      quelle: "manuell",
      titel: "Atemschutz-Übung",
      beginn: "2031-06-10T16:30:00.000Z",
      nurLeitende: true,
    });
    expect(await zeile(termin.id)).toMatchObject({
      einheitId: welt.einheit.jfA,
      quelle: "manuell",
      status: "aktiv",
      ganztaegig: false,
      ende: new Date("2031-06-10T18:30:00Z"),
      art: "Übung",
      googleOrt: "Magazin",
      thema: "Atemschutz",
      info: "Handschuhe",
      aufgebot: "18:00 im Magazin",
      inhaltHash: null,
    });
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.zielId, termin.id));
    expect(audit).toMatchObject([
      { aktion: "termin_angelegt", einheitId: welt.einheit.jfA },
    ]);
    // Winterzeit: 18:30 in Zürich ist 17:30 UTC
    const winter = await lege({
      beginn: "2031-12-10T18:30",
      ende: "2031-12-10T19:30",
    });
    expect(winter.beginn).toBe("2031-12-10T17:30:00.000Z");
  });

  test("ganztägig: Tage statt Zeiten; erscheint in der Liste mit Quelle", async () => {
    const termin = await lege({
      titel: "Lager",
      ganztaegig: true,
      beginn: undefined,
      ende: undefined,
      tagVon: "2031-07-01",
      tagBis: "2031-07-03",
    });
    expect(await zeile(termin.id)).toMatchObject({
      ganztaegig: true,
      tagVon: "2031-07-01",
      tagBis: "2031-07-03",
      beginn: null,
      ende: null,
    });
    const res = await app.request(`${basis()}?von=2031-07-02&bis=2031-07-02`, {
      headers: kommando.headers,
    });
    const { termine } = (await res.json()) as {
      termine: { id: string; quelle: string }[];
    };
    expect(termine.find((t) => t.id === termin.id)?.quelle).toBe("manuell");
    expect(termine.find((t) => t.id === eigener)).toBeUndefined();
  });

  test("ungültige Eingaben: 400, nichts gespeichert", async () => {
    const anzahl = async () =>
      (
        await db
          .select()
          .from(schema.programm)
          .where(eq(schema.programm.einheitId, welt.einheit.jfA))
      ).length;
    const vorher = await anzahl();
    const schlecht: Record<string, unknown>[] = [
      { titel: "" },
      { titel: "   " },
      { titel: "x".repeat(121) },
      { ende: "2031-06-10T18:30" },
      { ende: "2031-06-10T18:00" },
      { beginn: "2031-06-10T18:30:00Z" },
      { beginn: "2031-13-10T18:30" },
      { beginn: "0000-06-10T18:30" },
      { beginn: undefined },
      { tagVon: "2031-06-10" },
      { ganztaegig: true },
      { ganztaegig: true, tagVon: "2031-07-03", tagBis: "2031-07-01" },
      {
        ganztaegig: true,
        beginn: undefined,
        ende: undefined,
        tagVon: "2031-07-01",
      },
      { nurLeitende: "ja" },
      { quelle: "lodur" },
      { id: "x" },
      { status: "abgesagt" },
    ];
    for (const abweichung of schlecht) {
      const res = await sende("POST", "", { ...manuell, ...abweichung });
      expect(res.status, JSON.stringify(abweichung)).toBe(400);
    }
    expect(await anzahl()).toBe(vorher);
  });

  test("Einheit mit Lodur-Link: 409, die Termine kommen aus Lodur", async () => {
    const [bezirk] = await db
      .insert(schema.bezirk)
      .values({ name: `Link ${randomUUID()}` })
      .returning();
    const [e] = await db
      .insert(schema.einheit)
      .values({
        bezirkId: bezirk!.id,
        typ: "jf",
        name: "Mit Link",
        lodurUrlVerschluesselt: "geheim",
      })
      .returning();
    await db.insert(schema.einheitRolle).values({
      userId: kommando.id!,
      einheitId: e!.id,
      typ: "kommandant",
    });
    const res = await sende("POST", "", manuell, e!.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "LODUR_LINK_GESETZT" });
    expect(
      await db
        .select()
        .from(schema.programm)
        .where(eq(schema.programm.einheitId, e!.id)),
    ).toHaveLength(0);
  });

  test("fremde Einheit: 404", async () => {
    expect((await sende("POST", "", manuell, welt.einheit.kfA)).status).toBe(
      404,
    );
  });
});

describe("PUT …/termine/:id bei manuellen Terminen", () => {
  test("ändert Angaben und Zeit, Audit-Eintrag; null löscht optionale Texte", async () => {
    const { id } = await lege({ ort: "Magazin", info: "Handschuhe" });
    const res = await sende("PUT", `/${id}`, {
      titel: "Neu",
      ganztaegig: false,
      beginn: "2031-06-11T19:00",
      ende: "2031-06-11T21:00",
      ort: null,
      info: null,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id,
      titel: "Neu",
      quelle: "manuell",
      beginn: "2031-06-11T17:00:00.000Z",
    });
    expect(await zeile(id)).toMatchObject({
      titel: "Neu",
      googleOrt: null,
      info: null,
      ende: new Date("2031-06-11T19:00:00Z"),
    });
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.zielId, id));
    expect(audit.map((a) => a.aktion).sort()).toEqual([
      "termin_angelegt",
      "termin_geaendert",
    ]);
  });

  test("Wechsel auf ganztägig verlangt die Tage und leert die Zeiten", async () => {
    const { id } = await lege();
    expect((await sende("PUT", `/${id}`, { ganztaegig: true })).status).toBe(
      400,
    );
    expect(
      (
        await sende("PUT", `/${id}`, {
          ganztaegig: true,
          tagVon: "2031-06-10",
          tagBis: "2031-06-10",
        })
      ).status,
    ).toBe(200);
    expect(await zeile(id)).toMatchObject({
      ganztaegig: true,
      beginn: null,
      ende: null,
      tagVon: "2031-06-10",
    });
  });

  test("Termin einer anderen Einheit: 404", async () => {
    const { id } = await lege();
    expect(
      (await sende("PUT", `/${id}`, { titel: "x" }, welt.einheit.kfA)).status,
    ).toBe(404);
  });
});

describe("DELETE …/termine/:id", () => {
  test("löscht einen manuellen Termin, schreibt Audit", async () => {
    const { id } = await lege();
    expect((await sende("DELETE", `/${id}`)).status).toBe(204);
    expect(await zeile(id)).toBeUndefined();
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.zielId, id));
    expect(audit.map((a) => a.aktion).sort()).toEqual([
      "termin_angelegt",
      "termin_geloescht",
    ]);
    expect((await sende("DELETE", `/${id}`)).status).toBe(404);
  });

  test("Termin aus Lodur: 409, bleibt bestehen", async () => {
    const res = await sende("DELETE", `/${eigener}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "TERMIN_AUS_LODUR" });
    expect(await zeile(eigener)).toBeDefined();
  });

  test("Termin einer anderen Einheit: 404", async () => {
    expect((await sende("DELETE", `/${fremder}`)).status).toBe(404);
    expect(await zeile(fremder)).toBeDefined();
  });
});

describe("Push bei manuellen Terminen", () => {
  const tokens = new Map<string, string>();
  let nachrichten: TokenMessage[] = [];
  const fcm: Fcm = {
    async sendEach(liste) {
      nachrichten.push(...liste.filter((n) => tokens.has(n.token)));
      return { responses: liste.map(() => ({ success: true })) };
    },
  };
  const pushApp = erstelleApp({
    appMinVersion: "1.2.0",
    sql,
    db,
    auth,
    seiten: ladeSeiten(),
    fcm,
  });
  const mitPush = (methode: "PUT" | "DELETE", id: string, body?: unknown) =>
    pushApp.request(
      `/api/v1/admin/einheiten/${welt.einheit.jfA}/termine/${id}`,
      {
        method: methode,
        headers: { ...kommando.headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
  const empfaenger = () => nachrichten.map((n) => tokens.get(n.token)!).sort();

  async function konto(name: string) {
    const [k] = await db
      .insert(schema.user)
      .values({ name, email: `${randomUUID()}@example.org` })
      .returning();
    const [sitzung] = await db
      .insert(schema.session)
      .values({
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        userId: k!.id,
      })
      .returning();
    const token = `fcm-${randomUUID()}`;
    await db.insert(schema.pushToken).values({
      sessionId: sitzung!.id,
      token,
      userId: k!.id,
      plattform: "android",
    });
    tokens.set(token, name);
    return k!.id;
  }
  async function person(userId: string) {
    const [t] = await db
      .insert(schema.teilnehmende)
      .values({
        einheitId: welt.einheit.jfA,
        vorname: "Vorname",
        nachname: "Nachname",
      })
      .returning();
    await db.insert(schema.teilnehmendeKonto).values({
      teilnehmendeId: t!.id,
      userId,
      art: "eltern",
    });
    return t!.id;
  }

  test("Änderung: Push nur an Personen mit Antwort; Ort und Schalter allein lösen keinen aus", async () => {
    nachrichten = [];
    const { id } = await lege();
    const mitAntwort = await konto("mit-antwort");
    const ohneAntwort = await konto("ohne-antwort");
    const kind = await person(mitAntwort);
    await person(ohneAntwort);
    await db
      .insert(schema.teilnahme)
      .values({ programmId: id, teilnehmendeId: kind, status: "ja" });

    expect((await mitPush("PUT", id, { ort: "Werkhof" })).status).toBe(200);
    expect((await mitPush("PUT", id, { nurLeitende: false })).status).toBe(200);
    expect(nachrichten).toHaveLength(0);

    expect((await mitPush("PUT", id, { aufgebot: "17:45" })).status).toBe(200);
    expect(empfaenger()).toEqual(["mit-antwort"]);
    expect(nachrichten[0]).toMatchObject({
      notification: {
        title: "Atemschutz-Übung am Di 10.6. geändert",
        body: "Bitte Zeit und Aufgebot in der App prüfen.",
      },
      data: { typ: "programm", id },
    });
  });

  test("Löschen: Absage-Push an alle der Einheit, mit Titel und Tag", async () => {
    nachrichten = [];
    const { id } = await lege({ titel: "Waldtag" });
    const eltern = await konto("eltern-absage");
    await person(eltern);
    expect((await mitPush("DELETE", id)).status).toBe(204);
    expect(await zeile(id)).toBeUndefined();
    expect(
      nachrichten.find((n) => tokens.get(n.token) === "eltern-absage"),
    ).toMatchObject({
      notification: {
        title: "Waldtag am Di 10.6. abgesagt",
        body: "Mehr in Fire-Response.",
      },
      data: { typ: "programm", id },
    });
  });

  test("«nur Leitende»: Eltern erfahren von Änderung und Absage nichts", async () => {
    nachrichten = [];
    const { id } = await lege({ nurLeitende: true });
    const eltern = await konto("eltern-versteckt");
    const kind = await person(eltern);
    await db
      .insert(schema.teilnahme)
      .values({ programmId: id, teilnehmendeId: kind, status: "ja" });
    await mitPush("PUT", id, { titel: "Anders" });
    await mitPush("DELETE", id);
    expect(empfaenger()).not.toContain("eltern-versteckt");
  });
});
