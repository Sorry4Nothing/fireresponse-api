import { eq } from "drizzle-orm";
import postgres from "postgres";
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
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { ladeSeiten } from "../src/seiten.js";
import {
  APP,
  bereiteAuthTestsVor,
  cookiesAus,
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

let welt: Welt;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
});

// Jede Anfrage schreibt sonst eine Log-Zeile in die Testausgabe
let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

async function ich(konto: PersonaKonto) {
  return app.request("/api/v1/ich", { headers: konto.headers });
}

// Eine zweite Sitzung derselben Person, wie auf einem zweiten Gerät
async function zweiteSitzung(konto: PersonaKonto) {
  const anmeldung = await auth.api.signInUsername({
    body: { username: konto.benutzername!, password: konto.passwort! },
    returnHeaders: true,
  });
  return {
    "expo-origin": APP,
    "x-forwarded-for": zufallsIp(),
    cookie: cookiesAus(anmeldung),
  };
}

describe("GET /api/v1/ich", () => {
  test("liefert Profil, Rollen, Stufen und Kinder, ohne E-Mail und Bremsfelder", async () => {
    const konto = await legePersonaAn(welt, "leitendeAElternB");
    const antwort = await ich(konto);
    expect(antwort.status).toBe(200);
    const koerper = await antwort.json();
    expect(koerper).toEqual({
      id: konto.id,
      name: "Leitende A und zugleich Elternteil B",
      benutzername: konto.benutzername,
      admin: false,
      zweiterFaktor: false,
      mussPasswortAendern: false,
      datenschutzGelesenAm: null,
      telefon: null,
      bildUrl: null,
      pushProgramme: true,
      pushAnmeldungen: true,
      rollen: [{ stufeId: welt.stufeAId, typ: "leitung" }],
      // Die Stufen der Rollen und der Kinder, nach Name
      stufen: [
        { id: welt.stufeAId, name: "Stufe A", kuerzel: "A" },
        { id: welt.stufeBId, name: "Stufe B", kuerzel: "B" },
      ],
      kinder: [
        {
          id: welt.kindBId,
          vorname: "Kind",
          nachname: "B",
          stufeId: welt.stufeBId,
        },
      ],
    });
  });

  test("Admin ohne Rollen und Kinder: admin true, leere Listen", async () => {
    const konto = await legePersonaAn(welt, "admin");
    const koerper = await (await ich(konto)).json();
    expect(koerper).toMatchObject({
      admin: true,
      rollen: [],
      stufen: [],
      kinder: [],
    });
  });

  test("SL A: Rolle stufenleitung und die Stufe A", async () => {
    const konto = await legePersonaAn(welt, "slA");
    const koerper = await (await ich(konto)).json();
    expect(koerper).toMatchObject({
      admin: false,
      rollen: [{ stufeId: welt.stufeAId, typ: "stufenleitung" }],
      stufen: [{ id: welt.stufeAId, name: "Stufe A", kuerzel: "A" }],
      kinder: [],
    });
  });

  test("mit offenem Pflichtwechsel bleibt GET /ich offen und meldet das Flag", async () => {
    const konto = await legePersonaAn(welt, "mussPasswortAendern");
    const antwort = await ich(konto);
    expect(antwort.status).toBe(200);
    expect(await antwort.json()).toMatchObject({
      mussPasswortAendern: true,
      kinder: [{ id: welt.kindAId }],
    });
  });

  test("ein Kind der Demo-Abteilung und ein inaktives Kind bleiben draussen", async () => {
    const konto = await legePersonaAn(welt, "elternB");
    // Verknüpfung über die Abteilungsgrenze und ein inaktives Kind in einer eigenen Stufe
    const [stufeC] = await db
      .insert(schema.stufe)
      .values({
        abteilungId: welt.testabteilungId,
        name: "Stufe C",
        kuerzel: "C",
      })
      .returning();
    const [inaktiv] = await db
      .insert(schema.kind)
      .values({
        abteilungId: welt.testabteilungId,
        vorname: "Kind",
        nachname: "Inaktiv",
        stufeId: stufeC.id,
        inaktivSeit: new Date(),
      })
      .returning();
    await db.insert(schema.kindEltern).values([
      { kindId: welt.demoKindId, userId: konto.id! },
      { kindId: inaktiv.id, userId: konto.id! },
    ]);
    const koerper = await (await ich(konto)).json();
    expect(koerper).toMatchObject({
      kinder: [{ id: welt.kindBId }],
      stufen: [{ id: welt.stufeBId }],
    });
  });
});

describe("POST /api/v1/ich/datenschutz", () => {
  test("setzt das Datum einmal; ein zweiter Aufruf lässt das erste stehen", async () => {
    const konto = await legePersonaAn(welt, "elternA");
    const datum = async () =>
      (await (await ich(konto)).json()).datenschutzGelesenAm as string | null;
    expect(await datum()).toBeNull();

    const erste = await app.request("/api/v1/ich/datenschutz", {
      method: "POST",
      headers: konto.headers,
    });
    expect(erste.status).toBe(204);
    const gelesenAm = await datum();
    expect(gelesenAm).not.toBeNull();

    const zweite = await app.request("/api/v1/ich/datenschutz", {
      method: "POST",
      headers: konto.headers,
    });
    expect(zweite.status).toBe(204);
    expect(await datum()).toBe(gelesenAm);
  });
});

describe("PATCH /api/v1/ich", () => {
  async function patch(konto: PersonaKonto, body: unknown) {
    return app.request("/api/v1/ich", {
      method: "PATCH",
      headers: { ...konto.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function schalter(konto: PersonaKonto) {
    const profil = await (await ich(konto)).json();
    const [zeile] = await db
      .select({ pushProgramme: schema.user.pushProgramme })
      .from(schema.user)
      .where(eq(schema.user.id, konto.id!));
    // Die Antwort von GET /ich und die Zeile müssen übereinstimmen
    expect({ pushProgramme: profil.pushProgramme }).toEqual(zeile);
    return zeile;
  }

  test.each(["elternA", "leitendeA", "slA", "admin"] as const)(
    "%s schaltet den Push aus und wieder ein, für sich allein",
    async (persona) => {
      const konto = await legePersonaAn(welt, persona);
      const andere = await legePersonaAn(welt, "elternB");
      expect(await schalter(konto)).toEqual({ pushProgramme: true });

      expect((await patch(konto, { pushProgramme: false })).status).toBe(204);
      expect(await schalter(konto)).toEqual({ pushProgramme: false });

      expect((await patch(konto, { pushProgramme: true })).status).toBe(204);
      expect(await schalter(konto)).toEqual({ pushProgramme: true });
      // Eine andere Person bleibt, wie sie war
      expect(await schalter(andere)).toEqual({ pushProgramme: true });
    },
  );

  test.each([
    ["ein leerer Body", {}],
    ["ein Wert, der kein Boolean ist", { pushProgramme: "nein" }],
    ["ein fremdes Feld", { abteilungId: "x" }],
    [
      "ein fremdes Feld neben einem Schalter",
      { pushProgramme: false, email: "x@example.org" },
    ],
  ])("%s ergibt 400 und ändert nichts", async (_titel, body) => {
    const konto = await legePersonaAn(welt, "elternA");

    const antwort = await patch(konto, body);

    expect(antwort.status).toBe(400);
    expect(await schalter(konto)).toEqual({ pushProgramme: true });
  });
});

describe("Schalter pushAnmeldungen", () => {
  test("Leitende sehen ihn und schalten ihn aus und ein", async () => {
    const konto = await legePersonaAn(welt, "leitendeA");
    expect((await (await ich(konto)).json()).pushAnmeldungen).toBe(true);

    const patchen = (wert: boolean) =>
      app.request("/api/v1/ich", {
        method: "PATCH",
        headers: { ...konto.headers, "content-type": "application/json" },
        body: JSON.stringify({ pushAnmeldungen: wert }),
      });
    expect((await patchen(false)).status).toBe(204);
    expect((await (await ich(konto)).json()).pushAnmeldungen).toBe(false);
    expect((await patchen(true)).status).toBe(204);
    expect((await (await ich(konto)).json()).pushAnmeldungen).toBe(true);
  });

  test.each(["elternA", "admin"] as const)(
    "%s ohne Stufenrolle bekommt ihn nicht zu sehen",
    async (persona) => {
      const konto = await legePersonaAn(welt, persona);
      expect(await (await ich(konto)).json()).not.toHaveProperty(
        "pushAnmeldungen",
      );
    },
  );
});

describe("Sitzungen", () => {
  test("«Überall abmelden» beendet jede Sitzung der Person, keine einer anderen", async () => {
    const konto = await legePersonaAn(welt, "elternA");
    const andere = await legePersonaAn(welt, "elternB");
    const zweitgeraet = await zweiteSitzung(konto);
    expect((await ich(konto)).status).toBe(200);
    expect(
      (await app.request("/api/v1/ich", { headers: zweitgeraet })).status,
    ).toBe(200);

    const antwort = await app.request("/api/auth/revoke-sessions", {
      method: "POST",
      headers: konto.headers,
    });
    expect(antwort.status).toBe(200);

    expect((await ich(konto)).status).toBe(401);
    expect(
      (await app.request("/api/v1/ich", { headers: zweitgeraet })).status,
    ).toBe(401);
    const sitzung = await app.request("/api/auth/get-session", {
      headers: konto.headers,
    });
    expect(await sitzung.json()).toBeNull();
    expect((await ich(andere)).status).toBe(200);
  });

  test("Passwort ändern ohne Pflichtwechsel beendet die andere Sitzung; das neue Cookie gilt", async () => {
    const konto = await legePersonaAn(welt, "elternA");
    const zweitgeraet = await zweiteSitzung(konto);

    const antwort = await app.request("/api/auth/change-password", {
      method: "POST",
      headers: { ...konto.headers, "content-type": "application/json" },
      body: JSON.stringify({
        currentPassword: konto.passwort,
        newPassword: "nur-fuer-tests-neu-1",
      }),
    });
    expect(antwort.status).toBe(200);

    const neu = {
      "expo-origin": APP,
      "x-forwarded-for": zufallsIp(),
      cookie: cookiesAus(antwort),
    };
    expect((await app.request("/api/v1/ich", { headers: neu })).status).toBe(
      200,
    );
    expect(
      (await app.request("/api/v1/ich", { headers: zweitgeraet })).status,
    ).toBe(401);
  });
});

describe("Herkunft der App", () => {
  test("fireresponse:// und fireresponse://<host:port> sind vertraut, exp://… nicht", async () => {
    const konto = await legePersonaAn(welt, "elternA");
    const abmelden = (origin: string, cookie: string) =>
      app.request("/api/auth/sign-out", {
        method: "POST",
        headers: {
          "expo-origin": origin,
          "x-forwarded-for": zufallsIp(),
          cookie,
        },
      });

    const fremd = await abmelden("exp://192.0.2.1:8081", konto.headers.cookie);
    expect(fremd.status).toBe(403);
    expect(await fremd.json()).toMatchObject({ code: "INVALID_ORIGIN" });

    // Wie ein Release-Build; die Sitzung lebt noch, der fremde Ursprung wurde vor dem Handler abgewiesen
    expect(
      (await abmelden("fireresponse://", konto.headers.cookie)).status,
    ).toBe(200);

    // Wie ein Dev-Build, der den Metro-Host in die Herkunft nimmt
    const zweitgeraet = await zweiteSitzung(konto);
    expect(
      (await abmelden("fireresponse://192.0.2.1:8081", zweitgeraet.cookie))
        .status,
    ).toBe(200);
  });
});

describe("Kein Löschen durch die Person", () => {
  test("DELETE /api/v1/ich gibt es nicht: 404, das Konto bleibt", async () => {
    const konto = await legePersonaAn(welt, "elternA");
    const antwort = await app.request("/api/v1/ich", {
      method: "DELETE",
      headers: { ...konto.headers, "content-type": "application/json" },
      body: JSON.stringify({ passwort: konto.passwort }),
    });
    expect(antwort.status).toBe(404);
    expect((await ich(konto)).status).toBe(200);
  });
});
