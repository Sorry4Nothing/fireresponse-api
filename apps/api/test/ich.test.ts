import { and, eq } from "drizzle-orm";
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
import {
  EINWILLIGUNG_TEXT,
  EINWILLIGUNG_VERSION,
} from "../src/einwilligung.js";
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
  test("liefert Profil, Einheiten und Teilnehmende, ohne E-Mail und Bremsfelder", async () => {
    const konto = await legePersonaAn(welt, "leitendeJfAElternKfA");
    const antwort = await ich(konto);
    expect(antwort.status).toBe(200);
    const koerper = await antwort.json();
    expect(koerper).toEqual({
      id: konto.id,
      name: "Leitende JF A und zugleich Elternteil KF A",
      benutzername: konto.benutzername,
      kantonsadmin: false,
      zweiterFaktor: false,
      einwilligung: true,
      mussPasswortAendern: false,
      telefon: null,
      bildUrl: null,
      pushProgramme: true,
      pushAnmeldungen: true,
      einheiten: [
        {
          id: welt.einheit.jfA,
          name: "JF A",
          typ: "jf",
          bezirk: expect.stringMatching(/^Bezirk A /),
          rolle: "leitung",
          logoUrl: null,
          abzeichen: null,
        },
      ],
      teilnehmende: [
        {
          id: welt.teilnehmende.kfA,
          vorname: "Person",
          nachname: "KfA",
          einheitId: welt.einheit.kfA,
          einheitName: "KF A",
          einheitTyp: "kf",
          art: "eltern",
          abzeichen: null,
        },
      ],
    });
  });

  test("Teilnehmende und eigene Einheit tragen das Abzeichen des Rangs", async () => {
    const konto = await legePersonaAn(welt, "leitendeJfAElternKfA");
    // Ein Rang der KF A, nur mit Kürzel: das Objekt kommt trotzdem
    const [rangKf] = await db
      .insert(schema.rang)
      .values({
        einheitId: welt.einheit.kfA,
        name: "Ohne Abzeichen",
        kuerzel: "OA",
        typ: "kf",
        reihenfolge: 90,
      })
      .returning({ id: schema.rang.id });
    await db
      .update(schema.teilnehmende)
      .set({ rangId: rangKf.id })
      .where(eq(schema.teilnehmende.id, welt.teilnehmende.kfA));
    await db
      .update(schema.einheitRolle)
      .set({ rangId: welt.rangId })
      .where(eq(schema.einheitRolle.userId, konto.id!));
    try {
      const koerper = await (await ich(konto)).json();
      expect(koerper.teilnehmende[0].abzeichen).toEqual({
        kuerzel: "OA",
        sterne: null,
        bildUrl: null,
      });
      expect(koerper.einheiten[0].abzeichen).toEqual({
        kuerzel: "R1",
        sterne: 1,
        bildUrl: null,
      });
      expect(JSON.stringify(koerper)).not.toContain("rangId");
    } finally {
      await db
        .update(schema.teilnehmende)
        .set({ rangId: null })
        .where(eq(schema.teilnehmende.id, welt.teilnehmende.kfA));
      await db
        .update(schema.einheitRolle)
        .set({ rangId: null })
        .where(eq(schema.einheitRolle.userId, konto.id!));
      await db.delete(schema.rang).where(eq(schema.rang.id, rangKf.id));
    }
  });

  test("Kantonsadmin ohne Rolle und Teilnehmende: kantonsadmin true, leere Listen", async () => {
    const konto = await legePersonaAn(welt, "kantonsadmin");
    const koerper = await (await ich(konto)).json();
    expect(koerper).toMatchObject({
      kantonsadmin: true,
      einheiten: [],
      teilnehmende: [],
    });
  });

  test("Kommando JF A: Rolle kommandant in der Einheit", async () => {
    const konto = await legePersonaAn(welt, "kommandoJfA");
    const koerper = await (await ich(konto)).json();
    expect(koerper).toMatchObject({
      kantonsadmin: false,
      einheiten: [{ id: welt.einheit.jfA, rolle: "kommandant" }],
      teilnehmende: [],
    });
  });

  test("mit offenem Pflichtwechsel bleibt GET /ich offen und meldet das Flag", async () => {
    const konto = await legePersonaAn(welt, "mussPasswortAendern");
    const antwort = await ich(konto);
    expect(antwort.status).toBe(200);
    expect(await antwort.json()).toMatchObject({
      mussPasswortAendern: true,
      teilnehmende: [{ id: welt.teilnehmende.jfA }],
    });
  });

  test("eine inaktive teilnehmende Person bleibt draussen", async () => {
    const konto = await legePersonaAn(welt, "elternKfA");
    const [inaktiv] = await db
      .insert(schema.teilnehmende)
      .values({
        einheitId: welt.einheit.kfA,
        vorname: "Person",
        nachname: "Inaktiv",
        inaktivSeit: new Date(),
      })
      .returning();
    await db.insert(schema.teilnehmendeKonto).values({
      userId: konto.id!,
      teilnehmendeId: inaktiv.id,
      art: "eltern",
    });
    const koerper = await (await ich(konto)).json();
    expect(koerper.teilnehmende).toEqual([
      expect.objectContaining({ id: welt.teilnehmende.kfA }),
    ]);
  });

  test("Eltern mit einem Kind in der JF und einem in der KF: je Kind Name und Typ der eigenen Einheit, das Logo abrufbar", async () => {
    const konto = await legePersonaAn(welt, "elternKfA");
    await db.insert(schema.teilnehmendeKonto).values({
      userId: konto.id!,
      teilnehmendeId: welt.teilnehmende.jfA,
      art: "eltern",
    });
    try {
      const koerper = await (await ich(konto)).json();
      expect(koerper.einheiten).toEqual([]);
      const nachId = (id: string) =>
        koerper.teilnehmende.find((t: { id: string }) => t.id === id);
      expect(nachId(welt.teilnehmende.jfA)).toMatchObject({
        einheitId: welt.einheit.jfA,
        einheitName: "JF A",
        einheitTyp: "jf",
      });
      expect(nachId(welt.teilnehmende.kfA)).toMatchObject({
        einheitId: welt.einheit.kfA,
        einheitName: "KF A",
        einheitTyp: "kf",
      });
      // Das Logo unter der einheitId darf das Elternteil lesen: 404 ohne Logo, nie 403
      for (const einheitId of [welt.einheit.jfA, welt.einheit.kfA]) {
        const logo = await app.request(`/api/v1/einheiten/${einheitId}/logo`, {
          headers: konto.headers,
        });
        expect(logo.status).toBe(404);
      }
    } finally {
      await db
        .delete(schema.teilnehmendeKonto)
        .where(
          and(
            eq(schema.teilnehmendeKonto.userId, konto.id!),
            eq(schema.teilnehmendeKonto.teilnehmendeId, welt.teilnehmende.jfA),
          ),
        );
    }
  });

  test("Art selbst: die Person trägt Name und Typ ihrer Einheit", async () => {
    const konto = await legePersonaAn(welt, "teilnehmendeSelbstJfA");
    const koerper = await (await ich(konto)).json();
    expect(koerper.teilnehmende).toEqual([
      expect.objectContaining({
        art: "selbst",
        einheitName: "JF A",
        einheitTyp: "jf",
      }),
    ]);
  });

  test("ohne Einwilligung bleibt GET /ich offen und meldet es", async () => {
    const konto = await legePersonaAn(welt, "ohneEinwilligung");
    const antwort = await ich(konto);
    expect(antwort.status).toBe(200);
    expect(await antwort.json()).toMatchObject({ einwilligung: false });
  });
});

describe("Einwilligung", () => {
  const einwilligung = (konto: PersonaKonto, methode = "GET") =>
    app.request("/api/v1/einwilligung", {
      method: methode,
      headers: konto.headers,
    });

  test("GET liefert Version und Text der Fassung, PUT setzt Datum und Version", async () => {
    const konto = await legePersonaAn(welt, "ohneEinwilligung");
    expect(await (await einwilligung(konto)).json()).toEqual({
      version: EINWILLIGUNG_VERSION,
      text: EINWILLIGUNG_TEXT,
      gueltig: false,
    });

    expect((await einwilligung(konto, "PUT")).status).toBe(204);
    const [zeile] = await db
      .select({
        am: schema.user.einwilligungAm,
        version: schema.user.einwilligungVersion,
      })
      .from(schema.user)
      .where(eq(schema.user.id, konto.id!));
    expect(zeile.am).toBeInstanceOf(Date);
    expect(zeile.version).toBe(EINWILLIGUNG_VERSION);
    expect(await (await einwilligung(konto)).json()).toMatchObject({
      gueltig: true,
    });
  });

  test("ohne gültige Einwilligung sperrt die API die App-Routen", async () => {
    const konto = await legePersonaAn(welt, "ohneEinwilligung");
    const gesperrt = await app.request(
      "/api/v1/programme?von=2027-01-01&bis=2027-12-31",
      { headers: konto.headers },
    );
    expect(gesperrt.status).toBe(403);
    expect(await gesperrt.json()).toMatchObject({
      code: "EINWILLIGUNG_FEHLT",
    });
    // Offen bleiben Profil, Einwilligung und Abmelden
    expect((await ich(konto)).status).toBe(200);
    expect((await einwilligung(konto)).status).toBe(200);
    // Danach geht die Route
    await einwilligung(konto, "PUT");
    const offen = await app.request(
      "/api/v1/programme?von=2027-01-01&bis=2027-12-31",
      { headers: konto.headers },
    );
    expect(offen.status).toBe(200);
  });

  test("eine neuere Fassung verlangt die Einwilligung erneut", async () => {
    const konto = await legePersonaAn(welt, "elternJfA");
    await db
      .update(schema.user)
      .set({ einwilligungVersion: EINWILLIGUNG_VERSION - 1 })
      .where(eq(schema.user.id, konto.id!));
    expect((await ich(konto)).status).toBe(200);
    expect(await (await ich(konto)).json()).toMatchObject({
      einwilligung: false,
    });
    expect(
      (
        await app.request("/api/v1/programme?von=2027-01-01&bis=2027-12-31", {
          headers: konto.headers,
        })
      ).status,
    ).toBe(403);
  });

  test("die Verwaltung fragt die Einwilligung der App nicht ab", async () => {
    const konto = await legePersonaAn(welt, "kantonsadmin");
    await db
      .update(schema.user)
      .set({ einwilligungAm: null, einwilligungVersion: null })
      .where(eq(schema.user.id, konto.id!));
    expect(
      (await app.request("/api/v1/admin/system", { headers: konto.headers }))
        .status,
    ).toBe(200);
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

  test.each([
    "elternJfA",
    "leitendeJfA",
    "kommandoJfA",
    "kantonsadmin",
  ] as const)(
    "%s schaltet den Push aus und wieder ein, für sich allein",
    async (persona) => {
      const konto = await legePersonaAn(welt, persona);
      const andere = await legePersonaAn(welt, "elternKfA");
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
    ["ein fremdes Feld", { einheitId: "x" }],
    [
      "ein fremdes Feld neben einem Schalter",
      { pushProgramme: false, email: "x@example.org" },
    ],
  ])("%s ergibt 400 und ändert nichts", async (_titel, body) => {
    const konto = await legePersonaAn(welt, "elternJfA");

    const antwort = await patch(konto, body);

    expect(antwort.status).toBe(400);
    expect(await schalter(konto)).toEqual({ pushProgramme: true });
  });
});

describe("Schalter pushAnmeldungen", () => {
  test("Leitende sehen ihn und schalten ihn aus und ein", async () => {
    const konto = await legePersonaAn(welt, "leitendeJfA");
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

  test.each(["elternJfA", "kantonsadmin"] as const)(
    "%s ohne Rolle in einer Einheit bekommt ihn nicht zu sehen",
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
    const konto = await legePersonaAn(welt, "elternJfA");
    const andere = await legePersonaAn(welt, "elternKfA");
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
    const konto = await legePersonaAn(welt, "elternJfA");
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
    const konto = await legePersonaAn(welt, "elternJfA");
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
    const konto = await legePersonaAn(welt, "elternJfA");
    const antwort = await app.request("/api/v1/ich", {
      method: "DELETE",
      headers: { ...konto.headers, "content-type": "application/json" },
      body: JSON.stringify({ passwort: konto.passwort }),
    });
    expect(antwort.status).toBe(404);
    expect((await ich(konto)).status).toBe(200);
  });
});
