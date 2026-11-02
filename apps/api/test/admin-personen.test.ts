import { and, eq } from "drizzle-orm";
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
import * as schema from "../src/db/schema.js";
import { ladeSeiten } from "../src/seiten.js";
import {
  APP,
  bereiteAuthTestsVor,
  erstelleTestAuth,
  PASSWORT,
  zufallsIp,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  type Persona,
  type PersonaKonto,
  type Welt,
} from "./hilfen/personas.js";

bereiteAuthTestsVor();
// Das Startpasswort wird mit einem Schlüssel aus dem Geheimnis verschlüsselt; das ist der Standard von better-auth, mit dem auch die Sitzungen der Personas signiert sind
vi.stubEnv("BETTER_AUTH_SECRET", "better-auth-secret-12345678901234567890");

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

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

// Eine Welt pro Test: Kommando, Stellvertretungen und Passwörter ändern sich
let welt: Welt;
beforeEach(async () => {
  welt = await erstelleWelt(db, auth);
});
const person = (persona: Persona) => legePersonaAn(welt, persona);

function senden(
  konto: PersonaKonto,
  methode: string,
  url: string,
  body?: unknown,
) {
  return app.request(url, {
    method: methode,
    headers: {
      ...konto.headers,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const personen = (einheitId = welt.einheit.jfA) =>
  `/api/v1/admin/einheiten/${einheitId}/personen`;
const konto = (userId: string, rest = "", einheitId = welt.einheit.jfA) =>
  `${personen(einheitId)}/${userId}${rest}`;

interface Eintrag {
  id: string;
  name: string;
  rolle: string;
  eigenes: boolean;
  gemeinsam: boolean;
  zweiterFaktor: boolean;
  deaktiviert: boolean;
  startpasswort: null | { gueltigBis: string; abgelaufen: boolean };
  rang: null | { id: string; name: string };
  aktionen: Record<string, boolean>;
}
const liste = async (k: PersonaKonto, einheitId?: string) =>
  (
    (await (await senden(k, "GET", personen(einheitId))).json()) as {
      personen: Eintrag[];
    }
  ).personen;

const anmelden = (benutzername: string, passwort: string) =>
  app.request("/api/auth/sign-in/username", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "expo-origin": APP,
      "x-forwarded-for": zufallsIp(),
    },
    body: JSON.stringify({ username: benutzername, password: passwort }),
  });

describe("GET /personen", () => {
  test("zeigt Kommando, Stellvertretungen und Leitende mit Zustand, nie ein Passwort; die Aktionen folgen dem Akteur", async () => {
    const [kdt, stv1, stv2, leitung] = await Promise.all([
      person("kommandoJfA"),
      person("stellvertretung1JfA"),
      person("stellvertretung2JfA"),
      person("leitendeJfA"),
    ]);
    const text = await (await senden(kdt, "GET", personen())).text();
    expect(text).not.toMatch(/"password"|secret|backup|"email"/i);

    const vomKommando = await liste(kdt);
    expect(vomKommando.map((p) => p.rolle)).toEqual([
      "kommandant",
      "stellvertretung",
      "stellvertretung",
      "leitung",
    ]);
    const nachId = (l: Eintrag[], id: string | null) =>
      l.find((p) => p.id === id)!;
    // Am eigenen Konto fehlen alle Aktionen
    expect(nachId(vomKommando, kdt.id)).toMatchObject({
      eigenes: true,
      aktionen: {
        bearbeiten: false,
        startpasswort: false,
        deaktivieren: false,
        zweiterFaktor: false,
      },
    });
    expect(nachId(vomKommando, stv1.id)).toMatchObject({
      zweiterFaktor: true,
      aktionen: { startpasswort: true, zweiterFaktor: true },
    });
    expect(nachId(vomKommando, leitung.id)).toMatchObject({
      zweiterFaktor: false,
      deaktiviert: false,
      startpasswort: null,
      aktionen: { bearbeiten: true, deaktivieren: true },
    });

    // Eine Stellvertretung ändert weder das Kommando noch eine andere Stellvertretung
    const vonStv = await liste(stv1);
    expect(nachId(vonStv, kdt.id).aktionen).toEqual({
      bearbeiten: false,
      startpasswort: false,
      deaktivieren: false,
      zweiterFaktor: false,
    });
    expect(nachId(vonStv, stv2.id).aktionen.startpasswort).toBe(false);
    expect(nachId(vonStv, leitung.id).aktionen.startpasswort).toBe(true);
  });

  test("ein Konto mit Rolle in einer zweiten Einheit ist gemeinsam: Kommando bekommt keine Aktionen, der Kantonsadmin alle", async () => {
    const [kdt, admin, gemeinsam] = await Promise.all([
      person("kommandoJfA"),
      person("kantonsadmin"),
      person("leitendeJfAElternKfA"),
    ]);
    const vomKommando = (await liste(kdt)).find((p) => p.id === gemeinsam.id)!;
    expect(vomKommando.gemeinsam).toBe(true);
    expect(Object.values(vomKommando.aktionen)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    const vomAdmin = (await liste(admin)).find((p) => p.id === gemeinsam.id)!;
    expect(vomAdmin.aktionen.startpasswort).toBe(true);
    expect(
      (await senden(kdt, "POST", konto(gemeinsam.id!, "/startpasswort")))
        .status,
    ).toBe(409);
    expect(
      await (
        await senden(kdt, "POST", konto(gemeinsam.id!, "/startpasswort"))
      ).json(),
    ).toMatchObject({ code: "KONTO_GEMEINSAM" });
    expect(
      (await senden(admin, "POST", konto(gemeinsam.id!, "/startpasswort")))
        .status,
    ).toBe(200);
  });
});

describe("Startpasswort", () => {
  test("neu erzeugen: Antwort mit Startpasswort, Sitzungen enden, Anmeldung mit dem neuen, offen in der Liste und abrufbar", async () => {
    const [kdt, leitung] = await Promise.all([
      person("kommandoJfA"),
      person("leitendeJfA"),
    ]);
    const antwort = await senden(
      kdt,
      "POST",
      konto(leitung.id!, "/startpasswort"),
    );
    expect(antwort.status).toBe(200);
    const { startpasswort, gueltigBis } = (await antwort.json()) as {
      startpasswort: string;
      gueltigBis: string;
    };
    expect(startpasswort).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(new Date(gueltigBis).getTime()).toBeGreaterThan(Date.now());
    // Die alte Sitzung ist weg, das alte Passwort gilt nicht mehr
    expect((await senden(leitung, "GET", "/api/v1/ich")).status).toBe(401);
    expect((await anmelden(leitung.benutzername!, PASSWORT)).status).toBe(401);
    // Das neue Startpasswort gilt, auch klein und ohne Bindestriche
    const eintrag = (await liste(kdt)).find((p) => p.id === leitung.id)!;
    expect(eintrag.startpasswort).toMatchObject({ abgelaufen: false });
    expect(
      (
        await anmelden(
          leitung.benutzername!,
          startpasswort.toLowerCase().replaceAll("-", ""),
        )
      ).status,
    ).toBe(200);
    // Abruf, solange es offen ist
    const abruf = await senden(
      kdt,
      "GET",
      konto(leitung.id!, "/startpasswort"),
    );
    expect(await abruf.json()).toMatchObject({ startpasswort });
    // Das Protokoll nennt die Aktion, nie das Passwort
    const zeilen = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.zielId, leitung.id!));
    expect(zeilen.map((z) => z.aktion).sort()).toEqual([
      "startpasswort_angezeigt",
      "startpasswort_neu",
    ]);
    expect(JSON.stringify(zeilen)).not.toContain(startpasswort);
  });

  test("ohne offenes Startpasswort gibt der Abruf 409 KEIN_STARTPASSWORT", async () => {
    const [kdt, leitung] = await Promise.all([
      person("kommandoJfA"),
      person("leitendeJfA"),
    ]);
    const antwort = await senden(
      kdt,
      "GET",
      konto(leitung.id!, "/startpasswort"),
    );
    expect(antwort.status).toBe(409);
    expect(await antwort.json()).toMatchObject({ code: "KEIN_STARTPASSWORT" });
  });

  test("am eigenen Konto 409 EIGENES_KONTO; Leitende und Eltern dürfen es nicht (403)", async () => {
    const [kdt, leitung] = await Promise.all([
      person("kommandoJfA"),
      person("leitendeJfA"),
    ]);
    const eigenes = await senden(kdt, "POST", konto(kdt.id!, "/startpasswort"));
    expect(eigenes.status).toBe(409);
    expect(await eigenes.json()).toMatchObject({ code: "EIGENES_KONTO" });
    expect(
      (await senden(leitung, "POST", konto(kdt.id!, "/startpasswort"))).status,
    ).toBe(403);
  });

  test("Kommando, Stellvertretung: eine Stellvertretung setzt weder Kommando noch Stellvertretung zurück (403), Leitende schon", async () => {
    const [stv1, kdt, stv2, leitung] = await Promise.all([
      person("stellvertretung1JfA"),
      person("kommandoJfA"),
      person("stellvertretung2JfA"),
      person("leitendeJfA"),
    ]);
    const pfad = (id: string) => konto(id, "/startpasswort");
    expect((await senden(stv1, "POST", pfad(kdt.id!))).status).toBe(403);
    expect((await senden(stv1, "POST", pfad(stv2.id!))).status).toBe(403);
    expect((await senden(stv1, "POST", pfad(leitung.id!))).status).toBe(200);
    // Das Kommando darf die Stellvertretung
    expect((await senden(kdt, "POST", pfad(stv2.id!))).status).toBe(200);
  });

  test("Konten anderer Einheiten sind 404", async () => {
    const [kdtKfA, leitung] = await Promise.all([
      person("kommandoKfA"),
      person("leitendeJfA"),
    ]);
    expect(
      (
        await senden(
          kdtKfA,
          "POST",
          konto(leitung.id!, "/startpasswort", welt.einheit.jfA),
        )
      ).status,
    ).toBe(404);
    // In der eigenen Einheit ist die Person unbekannt
    expect(
      (
        await senden(
          kdtKfA,
          "POST",
          konto(leitung.id!, "/startpasswort", welt.einheit.kfA),
        )
      ).status,
    ).toBe(404);
  });
});

describe("Deaktivieren und Aktivieren", () => {
  test("deaktivieren beendet Sitzungen und sperrt die Anmeldung, aktivieren öffnet sie wieder", async () => {
    const [kdt, leitung] = await Promise.all([
      person("kommandoJfA"),
      person("leitendeJfA"),
    ]);
    expect(
      (await senden(kdt, "POST", konto(leitung.id!, "/deaktivieren"))).status,
    ).toBe(204);
    expect((await senden(leitung, "GET", "/api/v1/ich")).status).toBe(401);
    expect((await anmelden(leitung.benutzername!, PASSWORT)).status).toBe(401);
    const eintrag = (await liste(kdt)).find((p) => p.id === leitung.id)!;
    expect(eintrag.deaktiviert).toBe(true);
    expect(
      (await senden(kdt, "POST", konto(leitung.id!, "/aktivieren"))).status,
    ).toBe(204);
    expect((await anmelden(leitung.benutzername!, PASSWORT)).status).toBe(200);
    expect(
      (await liste(kdt)).find((p) => p.id === leitung.id)!.deaktiviert,
    ).toBe(false);
  });

  test("das eigene Konto lässt sich nicht deaktivieren", async () => {
    const kdt = await person("kommandoJfA");
    const antwort = await senden(kdt, "POST", konto(kdt.id!, "/deaktivieren"));
    expect(antwort.status).toBe(409);
    expect(await antwort.json()).toMatchObject({ code: "EIGENES_KONTO" });
  });
});

describe("Zweiter Faktor zurücksetzen", () => {
  test("setzt den Faktor zurück, ein zweites Mal 409 KEIN_ZWEITER_FAKTOR; Stellvertretung am Kommando 403", async () => {
    const [kdt, stv1] = await Promise.all([
      person("kommandoJfA"),
      person("stellvertretung1JfA"),
    ]);
    const pfad = (id: string) => konto(id, "/zweiter-faktor-zuruecksetzen");
    expect((await senden(stv1, "POST", pfad(kdt.id!))).status).toBe(403);
    expect((await senden(kdt, "POST", pfad(stv1.id!))).status).toBe(204);
    const nochmals = await senden(kdt, "POST", pfad(stv1.id!));
    expect(nochmals.status).toBe(409);
    expect(await nochmals.json()).toMatchObject({
      code: "KEIN_ZWEITER_FAKTOR",
    });
    const [zeile] = await db
      .select({ an: schema.user.twoFactorEnabled })
      .from(schema.user)
      .where(eq(schema.user.id, stv1.id!));
    expect(zeile.an).toBe(false);
    const [eintrag] = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.zielId, stv1.id!),
          eq(schema.auditLog.aktion, "zweiter_faktor_zurueckgesetzt"),
        ),
      );
    expect(eintrag.einheitId).toBe(welt.einheit.jfA);
  });
});

describe("PATCH /personen/:userId", () => {
  test("Name und Nummer ändern; die Nummer nur bei Kommando und Stellvertretung; der Rang gehört zur Einheit", async () => {
    const [kdt, stv1, leitung] = await Promise.all([
      person("kommandoJfA"),
      person("stellvertretung1JfA"),
      person("leitendeJfA"),
    ]);
    expect(
      (await senden(kdt, "PATCH", konto(leitung.id!), { name: "Neuer Name" }))
        .status,
    ).toBe(204);
    // Leitende sind keine Kontakte
    expect(
      (
        await senden(kdt, "PATCH", konto(leitung.id!), {
          telefon: "+41 44 123 45 67",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await senden(kdt, "PATCH", konto(stv1.id!), {
          telefon: "+41 44 123 45 67",
        })
      ).status,
    ).toBe(204);
    expect(
      (await senden(kdt, "PATCH", konto(stv1.id!), { telefon: "" })).status,
    ).toBe(204);
    // Rang: der der Einheit ja, der einer anderen nein; null entfernt ihn
    expect(
      (await senden(kdt, "PATCH", konto(leitung.id!), { rangId: welt.rangId }))
        .status,
    ).toBe(204);
    const eintrag = (await liste(kdt)).find((p) => p.id === leitung.id)!;
    expect(eintrag.name).toBe("Neuer Name");
    expect(eintrag.rang).toEqual({ id: welt.rangId, name: "Rang Eins" });
    const [fremd] = await db
      .insert(schema.rang)
      .values({
        einheitId: welt.einheit.kfA,
        name: "Fremd",
        kuerzel: "F",
        reihenfolge: 1,
      })
      .returning({ id: schema.rang.id });
    expect(
      (await senden(kdt, "PATCH", konto(leitung.id!), { rangId: fremd.id }))
        .status,
    ).toBe(400);
    expect(
      (await senden(kdt, "PATCH", konto(leitung.id!), { rangId: null })).status,
    ).toBe(204);
    // Nur Rang statt Name: Die Stellvertretung darf das Kommando einordnen, aber nicht umbenennen
    expect(
      (await senden(stv1, "PATCH", konto(kdt.id!), { name: "Chef" })).status,
    ).toBe(403);
    expect(
      (await senden(stv1, "PATCH", konto(kdt.id!), { rangId: welt.rangId }))
        .status,
    ).toBe(204);
    // Das Protokoll nennt die Felder, nie die Werte
    const zeilen = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.zielId, leitung.id!));
    expect(JSON.stringify(zeilen)).not.toContain("Neuer Name");
  });

  test("leerer Body, fremde Felder und ein eigenes Konto mit Teilnehmenden-Namen werden abgelehnt", async () => {
    const [kdt, leitung] = await Promise.all([
      person("kommandoJfA"),
      person("leitendeJfA"),
    ]);
    expect((await senden(kdt, "PATCH", konto(leitung.id!), {})).status).toBe(
      400,
    );
    expect(
      (await senden(kdt, "PATCH", konto(leitung.id!), { role: "admin" }))
        .status,
    ).toBe(400);
    const selbst = await person("teilnehmendeSelbstJfA");
    expect(
      (await senden(kdt, "PATCH", konto(selbst.id!), { name: "Anders" }))
        .status,
    ).toBe(400);
  });
});

describe("DELETE /leitende/:userId", () => {
  test("entfernt die Rolle, das Konto bleibt; Stellvertretungen gehen so nicht", async () => {
    const [kdt, stv1, leitung] = await Promise.all([
      person("kommandoJfA"),
      person("stellvertretung1JfA"),
      person("leitendeJfA"),
    ]);
    const pfad = (id: string) =>
      `/api/v1/admin/einheiten/${welt.einheit.jfA}/leitende/${id}`;
    expect((await senden(kdt, "DELETE", pfad(stv1.id!))).status).toBe(404);
    expect((await senden(kdt, "DELETE", pfad(leitung.id!))).status).toBe(204);
    expect((await senden(kdt, "DELETE", pfad(leitung.id!))).status).toBe(404);
    const [konto_] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.id, leitung.id!));
    expect(konto_.id).toBe(leitung.id);
    expect((await liste(kdt)).some((p) => p.id === leitung.id)).toBe(false);
    // Leitende dürfen es nicht
    const andere = await person("leitendeJfAElternKfA");
    expect((await senden(andere, "DELETE", pfad(andere.id!))).status).toBe(403);
  });
});

describe("Teilnehmende", () => {
  const url = (rest = "", einheitId = welt.einheit.jfA) =>
    `/api/v1/admin/einheiten/${einheitId}/teilnehmende${rest}`;
  interface Tn {
    id: string;
    vorname: string;
    nachname: string;
    aktiv: boolean;
    rang: null | { id: string };
    konten: {
      id: string;
      art: string;
      benutzername: string;
      eigenes: boolean;
      aktionen: Record<string, boolean>;
    }[];
  }
  const lesen = async (k: PersonaKonto) =>
    (
      (await (await senden(k, "GET", url())).json()) as {
        teilnehmende: Tn[];
      }
    ).teilnehmende;

  test("GET zeigt die Personen mit ihren Konten; ohne Konto bleibt die Liste leer (Hinweis «keine Eltern»)", async () => {
    const [kdt, eltern, selbst] = await Promise.all([
      person("kommandoJfA"),
      person("elternJfA"),
      person("teilnehmendeSelbstJfA"),
    ]);
    const liste_ = await lesen(kdt);
    const text = JSON.stringify(liste_);
    expect(text).not.toMatch(/"password"|secret|backup|"email"/i);
    const jfA = liste_.find((t) => t.id === welt.teilnehmende.jfA)!;
    expect(jfA.konten.map((k) => k.id)).toContain(eltern.id);
    expect(jfA.konten.find((k) => k.id === eltern.id)).toMatchObject({
      art: "eltern",
      aktionen: { startpasswort: true, bearbeiten: true },
    });
    const wechsel = liste_.find((t) => t.id === welt.teilnehmende.jfAWechsel)!;
    expect(wechsel.konten).toEqual([
      expect.objectContaining({ id: selbst.id, art: "selbst" }),
    ]);
    // jfA2 hat die Eltern nach dem Wechsel; eine neue Person ohne Konto
    const [ohne] = await db
      .insert(schema.teilnehmende)
      .values({
        einheitId: welt.einheit.jfA,
        vorname: "Ohne",
        nachname: "Konto",
      })
      .returning({ id: schema.teilnehmende.id });
    expect((await lesen(kdt)).find((t) => t.id === ohne.id)!.konten).toEqual(
      [],
    );
    // Eine Person einer anderen Einheit erscheint nie
    expect(liste_.some((t) => t.id === welt.teilnehmende.kfA)).toBe(false);
  });

  test("Namen, Rang und aktiv ändern; das eigene Konto trägt den neuen Namen mit", async () => {
    const [kdt, selbst] = await Promise.all([
      person("kommandoJfA"),
      person("teilnehmendeSelbstJfA"),
    ]);
    const id = welt.teilnehmende.jfAWechsel;
    expect(
      (
        await senden(kdt, "PATCH", url(`/${id}`), {
          vorname: "Neu",
          nachname: "Benannt",
          rangId: welt.rangId,
          aktiv: false,
        })
      ).status,
    ).toBe(204);
    const person_ = (await lesen(kdt)).find((t) => t.id === id)!;
    expect(person_).toMatchObject({
      vorname: "Neu",
      nachname: "Benannt",
      aktiv: false,
      rang: { id: welt.rangId },
    });
    const [konto_] = await db
      .select({ name: schema.user.name })
      .from(schema.user)
      .where(eq(schema.user.id, selbst.id!));
    expect(konto_.name).toBe("Neu Benannt");
    // Inaktiv sieht das eigene Konto die Person nicht mehr
    const [zeile] = await db
      .select({ seit: schema.teilnehmende.inaktivSeit })
      .from(schema.teilnehmende)
      .where(eq(schema.teilnehmende.id, id));
    expect(zeile.seit).not.toBeNull();
    // Wieder aktiv
    expect(
      (await senden(kdt, "PATCH", url(`/${id}`), { aktiv: true, rangId: null }))
        .status,
    ).toBe(204);
    expect((await lesen(kdt)).find((t) => t.id === id)).toMatchObject({
      aktiv: true,
      rang: null,
    });
  });

  test("fremde Ränge und Personen anderer Einheiten werden abgelehnt", async () => {
    const [kdt, kdtKfA] = await Promise.all([
      person("kommandoJfA"),
      person("kommandoKfA"),
    ]);
    const [fremd] = await db
      .insert(schema.rang)
      .values({
        einheitId: welt.einheit.kfA,
        name: "Fremd",
        kuerzel: "F",
        reihenfolge: 1,
      })
      .returning({ id: schema.rang.id });
    const id = welt.teilnehmende.jfA;
    expect(
      (await senden(kdt, "PATCH", url(`/${id}`), { rangId: fremd.id })).status,
    ).toBe(400);
    expect((await senden(kdt, "PATCH", url(`/${id}`), {})).status).toBe(400);
    // Die Person gehört zu JF A: das Kommando von KF A sieht die Einheit nicht
    expect(
      (await senden(kdtKfA, "PATCH", url(`/${id}`), { aktiv: false })).status,
    ).toBe(404);
    // In der eigenen Einheit ist die Person unbekannt
    expect(
      (
        await senden(kdtKfA, "PATCH", url(`/${id}`, welt.einheit.kfA), {
          aktiv: false,
        })
      ).status,
    ).toBe(404);
  });

  test("Aktionen am Konto der Eltern laufen über /personen/:userId der Einheit", async () => {
    const [kdt, eltern] = await Promise.all([
      person("kommandoJfA"),
      person("elternJfA"),
    ]);
    const antwort = await senden(
      kdt,
      "POST",
      konto(eltern.id!, "/startpasswort"),
    );
    expect(antwort.status).toBe(200);
    // Eltern mit Kindern in zwei Bezirken: ein gemeinsames Konto
    const zwei = await person("elternAundB");
    const gemeinsam = await senden(
      kdt,
      "POST",
      konto(zwei.id!, "/startpasswort"),
    );
    expect(gemeinsam.status).toBe(409);
    expect(await gemeinsam.json()).toMatchObject({ code: "KONTO_GEMEINSAM" });
  });
});

describe("Einheiten und System", () => {
  test("GET /einheiten nennt Kommando, aktive Teilnehmende, Rolle und Sync-Stand, nie den Link", async () => {
    const [admin, kdt] = await Promise.all([
      person("kantonsadmin"),
      person("kommandoJfA"),
    ]);
    await db
      .update(schema.einheit)
      .set({
        lodurUrlVerschluesselt: "geheim-verschluesselt",
        syncFehler: "TIMEOUT",
      })
      .where(eq(schema.einheit.id, welt.einheit.jfA));
    const antwort = await senden(admin, "GET", "/api/v1/admin/einheiten");
    const text = await antwort.text();
    expect(text).not.toContain("geheim-verschluesselt");
    const { einheiten } = JSON.parse(text) as {
      einheiten: {
        id: string;
        kommandant: { id: string } | null;
        lodurHinterlegt: boolean;
        syncFehler: string | null;
        teilnehmende: number;
        rolle: string | null;
      }[];
    };
    const jfA = einheiten.find((e) => e.id === welt.einheit.jfA)!;
    expect(jfA).toMatchObject({
      kommandant: { id: kdt.id },
      lodurHinterlegt: true,
      syncFehler: "TIMEOUT",
      rolle: null,
    });
    expect(jfA.teilnehmende).toBeGreaterThanOrEqual(3);
    const eigene = (await (
      await senden(kdt, "GET", "/api/v1/admin/einheiten")
    ).json()) as { einheiten: { id: string; rolle: string }[] };
    expect(eigene.einheiten).toEqual([
      expect.objectContaining({ id: welt.einheit.jfA, rolle: "kommandant" }),
    ]);
  });

  test("GET /system/changes: neueste zuerst, mit Namen, seitenweise; nur der Kantonsadmin", async () => {
    const [admin, kdt] = await Promise.all([
      person("kantonsadmin"),
      person("kommandoJfA"),
    ]);
    const leitung = await person("leitendeJfA");
    for (const aktion of ["startpasswort", "deaktivieren", "aktivieren"]) {
      await senden(kdt, "POST", konto(leitung.id!, `/${aktion}`));
    }
    expect(
      (await senden(kdt, "GET", "/api/v1/admin/system/changes")).status,
    ).toBe(403);
    type Antwort = {
      eintraege: {
        id: string;
        aktion: string;
        zielId: string;
        akteur: { name: string | null; cli: boolean };
        einheit: { name: string } | null;
      }[];
      weiter: string | null;
    };
    // Andere Testdateien schreiben gleichzeitig ins Protokoll: die eigenen Einträge nach Ziel suchen
    const alle = (await (
      await senden(admin, "GET", "/api/v1/admin/system/changes?limit=200")
    ).json()) as Antwort;
    const eigene = alle.eintraege.filter((e) => e.zielId === leitung.id);
    expect(eigene.map((e) => e.aktion)).toEqual([
      "person_aktiviert",
      "person_deaktiviert",
      "startpasswort_neu",
    ]);
    expect(eigene[0]).toMatchObject({
      akteur: { name: "Kommando JF A", cli: false },
      einheit: { name: "JF A" },
    });
    const erste = (await (
      await senden(admin, "GET", "/api/v1/admin/system/changes?limit=2")
    ).json()) as Antwort;
    expect(erste.eintraege).toHaveLength(2);
    expect(erste.weiter).toBe(erste.eintraege[1].id);
    const zweite = (await (
      await senden(
        admin,
        "GET",
        `/api/v1/admin/system/changes?limit=2&vor=${erste.weiter}`,
      )
    ).json()) as Antwort;
    // Strikt älter als der letzte Eintrag der ersten Seite (UUIDv7 sortiert nach Zeit)
    expect(zweite.eintraege.every((e) => e.id < erste.weiter!)).toBe(true);
    expect(
      (await senden(admin, "GET", "/api/v1/admin/system/changes?limit=500"))
        .status,
    ).toBe(400);
  });

  test("GET /system/sync zeigt Zeitpunkt und Fehlercode je Einheit, nie den Link", async () => {
    const [admin, kdt] = await Promise.all([
      person("kantonsadmin"),
      person("kommandoJfA"),
    ]);
    const jetzt = new Date();
    await db
      .update(schema.einheit)
      .set({ lodurUrlVerschluesselt: "geheim", syncOkAm: jetzt })
      .where(eq(schema.einheit.id, welt.einheit.jfA));
    expect((await senden(kdt, "GET", "/api/v1/admin/system/sync")).status).toBe(
      403,
    );
    const antwort = await senden(admin, "GET", "/api/v1/admin/system/sync");
    const text = await antwort.text();
    expect(text).not.toContain("geheim");
    const { einheiten } = JSON.parse(text) as {
      einheiten: {
        id: string;
        lodurHinterlegt: boolean;
        syncOkAm: string | null;
      }[];
    };
    const jfA = einheiten.find((e) => e.id === welt.einheit.jfA)!;
    expect(jfA.lodurHinterlegt).toBe(true);
    expect(new Date(jfA.syncOkAm!).getTime()).toBe(jetzt.getTime());
    expect(
      einheiten.find((e) => e.id === welt.einheit.kfA)!.lodurHinterlegt,
    ).toBe(false);
  });
});
