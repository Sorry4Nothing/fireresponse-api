import { randomUUID } from "node:crypto";
import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";
import { symmetricDecrypt } from "better-auth/crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { erstelleAuth, erstelleAuthRouten, offenePfade } from "../src/auth.js";
import {
  erzeugeStartpasswort,
  normalisiereStartpasswort,
} from "../src/startpasswort.js";
import {
  APP,
  bereiteAuthTestsVor,
  cookiesAus,
  GELEAKT,
  geschlossenePfade,
  PASSWORT,
} from "./hilfen/auth.js";

bereiteAuthTestsVor();

const NEU = "nur-fuer-tests-2";
// Für Konten mit offenem Startpasswort gleich die normalisierte Form: Der sign-in-Hook ersetzt die Eingabe durch genau diese, die Normalisierung selbst prüfen login- und pflichtwechsel-Tests
const STARTPASSWORT = normalisiereStartpasswort(erzeugeStartpasswort());
const TOKEN = "__Secure-better-auth.session_token";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Die acht Pfade aus dem Issue, bewusst unabhängig von src/auth.ts
const OFFEN = [
  "POST /api/auth/sign-in/username",
  "POST /api/auth/sign-out",
  "GET /api/auth/get-session",
  "POST /api/auth/change-password",
  "POST /api/auth/revoke-sessions",
  "POST /api/auth/two-factor/verify-totp",
  "POST /api/auth/two-factor/verify-backup-code",
  "POST /api/auth/two-factor/enable",
];

let db: MemoryDB;
let auth: ReturnType<typeof erstelleAuth>;
let app: ReturnType<typeof erstelleAuthRouten>;
beforeEach(() => {
  // rateLimit dabei: Das Limit zählt jede Anfrage an auth.handler in der Datenbank
  db = {
    user: [],
    session: [],
    account: [],
    verification: [],
    twoFactor: [],
    rateLimit: [],
  };
  auth = erstelleAuth(memoryAdapter(db));
  app = erstelleAuthRouten(auth);
});

// Kopfzeilen wie vom expoClient aus @better-auth/expo: expo-origin, x-skip-oauth-proxy und das gespeicherte Cookie
function anfrage(
  pfad: string,
  { methode = "POST", cookie = "", body = {} } = {},
) {
  const headers = new Headers({
    "expo-origin": APP,
    "x-skip-oauth-proxy": "true",
  });
  if (cookie) headers.set("cookie", cookie);
  const post = methode === "POST";
  if (post) headers.set("content-type", "application/json");
  return new Request(`https://fireresponse.invalid/api/auth/${pfad}`, {
    method: methode,
    headers,
    body: post ? JSON.stringify(body) : undefined,
  });
}

let laufnummer = 0;
async function legeAn(
  rolle: "admin" | "user" = "user",
  daten: Record<string, unknown> = {},
  passwort = PASSWORT,
) {
  const benutzername = `person${++laufnummer}`;
  const { user } = await auth.api.createUser({
    body: {
      email: `${randomUUID()}@example.org`,
      password: passwort,
      name: "Testperson",
      role: rolle,
      // Sonst gilt der Standardwert true, und ohne künftiges Ablaufdatum scheitert jede Anmeldung
      data: { username: benutzername, mussPasswortAendern: false, ...daten },
    },
  });
  return { id: user.id, benutzername };
}

async function anmelden(benutzername: string, passwort = PASSWORT) {
  const antwort = await app.request(
    anfrage("sign-in/username", {
      body: { username: benutzername, password: passwort },
    }),
  );
  expect(antwort.status).toBe(200);
  return cookiesAus(antwort);
}

async function sitzungZu(cookie: string) {
  const antwort = await app.request(
    anfrage("get-session", { methode: "GET", cookie }),
  );
  expect(antwort.status).toBe(200);
  return antwort.json();
}

const person = (id: string) => db.user.find((u) => u.id === id);
const sitzungenVon = (id: string) => db.session.filter((s) => s.userId === id);

async function totpCode(nutzerId: string) {
  const { secretConfig } = await auth.$context;
  const secret = await symmetricDecrypt({
    key: secretConfig,
    data: db.twoFactor.find((z) => z.userId === nutzerId).secret,
  });
  return (await auth.api.generateTOTP({ body: { secret } })).code;
}

async function totpEinschalten(
  id: string,
  cookie: string,
  passwort = PASSWORT,
) {
  const einrichten = await app.request(
    anfrage("two-factor/enable", { cookie, body: { password: passwort } }),
  );
  expect(einrichten.status).toBe(200);
  const { totpURI, backupCodes } = await einrichten.json();
  const bestaetigen = await app.request(
    anfrage("two-factor/verify-totp", {
      cookie,
      body: { code: await totpCode(id) },
    }),
  );
  expect(bestaetigen.status).toBe(200);
  return { neuesCookie: cookiesAus(bestaetigen), totpURI, backupCodes };
}

async function adminMitTotp(
  daten: Record<string, unknown> = {},
  passwort = PASSWORT,
) {
  const admin = await legeAn("admin", daten, passwort);
  const cookie = await anmelden(admin.benutzername, passwort);
  return {
    ...admin,
    cookie,
    ...(await totpEinschalten(admin.id, cookie, passwort)),
  };
}

describe("Positivliste: Hono reicht nur acht Pfade an auth.handler weiter", () => {
  const geschlossen = geschlossenePfade(OFFEN);

  test("offenePfade sind genau die acht Pfade aus dem Issue", () => {
    expect(offenePfade).toEqual(OFFEN);
  });

  test.each(geschlossen)("%s liefert 404", async (eintrag) => {
    const [methode, pfad] = eintrag.split(" ");
    const weitergereicht = vi.spyOn(auth, "handler");
    const antwort = await app.request(
      anfrage(pfad.replace("/api/auth/", ""), { methode }),
    );
    expect(antwort.status).toBe(404);
    expect(weitergereicht).not.toHaveBeenCalled();
  });

  test.each(OFFEN.filter((e) => !e.endsWith("/two-factor/enable")))(
    "%s erreicht auth.handler",
    async (eintrag) => {
      const [methode, pfad] = eintrag.split(" ");
      const weitergereicht = vi.spyOn(auth, "handler");
      const antwort = await app.request(
        anfrage(pfad.replace("/api/auth/", ""), { methode }),
      );
      expect(weitergereicht).toHaveBeenCalledOnce();
      expect(antwort.status).not.toBe(404);
    },
  );

  test("POST two-factor/enable erreicht auth.handler nur mit Admin-Sitzung, sonst 404", async () => {
    const normal = await anmelden((await legeAn()).benutzername);
    const admin = await anmelden((await legeAn("admin")).benutzername);
    const weitergereicht = vi.spyOn(auth, "handler");
    const body = { password: PASSWORT };

    expect(
      (await app.request(anfrage("two-factor/enable", { body }))).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          anfrage("two-factor/enable", { cookie: normal, body }),
        )
      ).status,
    ).toBe(404);
    expect(weitergereicht).not.toHaveBeenCalled();

    const antwort = await app.request(
      anfrage("two-factor/enable", { cookie: admin, body }),
    );
    expect(antwort.status).toBe(200);
    expect(weitergereicht).toHaveBeenCalledOnce();
  });
});

describe("Herkunft: better-auth prüft jeden POST mit Cookie", () => {
  test("expo-origin des App-Schemas geht, eine fremde Herkunft liefert 403 INVALID_ORIGIN, keine 403 MISSING_OR_NULL_ORIGIN", async () => {
    const cookie = await anmelden((await legeAn()).benutzername);

    const fremd = anfrage("sign-out", { cookie });
    fremd.headers.set("expo-origin", "fremdeapp://");
    const ohne = anfrage("sign-out", { cookie });
    ohne.headers.delete("expo-origin");
    for (const [eingang, code] of [
      [fremd, "INVALID_ORIGIN"],
      [ohne, "MISSING_OR_NULL_ORIGIN"],
    ] as const) {
      const antwort = await app.request(eingang);
      expect(antwort.status).toBe(403);
      expect((await antwort.json()).code).toBe(code);
    }
    expect(await sitzungZu(cookie)).not.toBeNull();

    expect((await app.request(anfrage("sign-out", { cookie }))).status).toBe(
      200,
    );
    expect(await sitzungZu(cookie)).toBeNull();
  });

  test("auch direkt über auth.handler: Ohne origin hilft expo-origin nicht, mit origin des App-Schemas geht es", async () => {
    const cookie = await anmelden((await legeAn()).benutzername);

    const ohne = await auth.handler(anfrage("sign-out", { cookie }));
    expect(ohne.status).toBe(403);
    expect((await ohne.json()).code).toBe("MISSING_OR_NULL_ORIGIN");

    const mit = anfrage("sign-out", { cookie });
    mit.headers.set("origin", APP);
    expect((await auth.handler(mit)).status).toBe(200);
  });

  test("sign-in/username ohne Cookie prüft die Herkunft nicht: Auch eine fremde meldet an", async () => {
    const { benutzername } = await legeAn();
    const eingang = anfrage("sign-in/username", {
      body: { username: benutzername, password: PASSWORT },
    });
    eingang.headers.set("expo-origin", "fremdeapp://");
    expect((await app.request(eingang)).status).toBe(200);
  });
});

describe("Zusatzfelder mit input: false", () => {
  // Nur Werte, die als wahr gelten: update-user verwirft false, 0 und null stillschweigend, sie bewiesen hier nichts
  const gesetzt = {
    mussPasswortAendern: true,
    startpasswortGueltigBis: new Date(Date.now() + 86_400_000),
    fehlversuche: 2,
    naechsterVersuchAb: new Date(Date.now() - 60_000),
    deaktiviertAm: new Date(Date.now() - 86_400_000),
    telefon: "keine-nummer",
    pushProgramme: true,
    pushAnmeldungen: true,
    einwilligungAm: new Date(Date.now() - 3_600_000),
    einwilligungVersion: 1,
  };

  test("auth.api.createUser setzt sie auf dem Server", async () => {
    const { id } = await legeAn("user", gesetzt);
    expect(person(id)).toMatchObject(gesetzt);
  });

  test.each([
    ["mussPasswortAendern", true],
    [
      "startpasswortGueltigBis",
      new Date(Date.now() + 9 * 86_400_000).toISOString(),
    ],
    ["fehlversuche", 9],
    ["naechsterVersuchAb", new Date(Date.now() + 86_400_000).toISOString()],
    ["deaktiviertAm", new Date().toISOString()],
    ["telefon", "andere-nummer"],
    ["pushProgramme", true],
    ["pushAnmeldungen", true],
    ["einwilligungAm", new Date().toISOString()],
    ["einwilligungVersion", 2],
  ])(
    "update-user mit %s liefert 400 FIELD_NOT_ALLOWED, direkt über auth.handler und über auth.api.updateUser",
    async (feld, wert) => {
      const { id, benutzername } = await legeAn("user", {
        ...gesetzt,
        mussPasswortAendern: false,
      });
      const cookie = await anmelden(benutzername);
      const vorher = { ...person(id) };
      const body = { name: "Geaendert", [feld]: wert };

      const direkt = anfrage("update-user", { cookie, body });
      direkt.headers.set("origin", APP);
      const antwort = await auth.handler(direkt);
      expect(antwort.status).toBe(400);
      expect((await antwort.json()).code).toBe("FIELD_NOT_ALLOWED");

      await expect(
        auth.api.updateUser({ headers: new Headers({ cookie }), body }),
      ).rejects.toMatchObject({
        statusCode: 400,
        body: { code: "FIELD_NOT_ALLOWED" },
      });
      expect(person(id)).toEqual(vorher);
    },
  );

  test("update-user verwirft false und null stillschweigend; die gespeicherten Werte bleiben", async () => {
    const { id, benutzername } = await legeAn("user", gesetzt, STARTPASSWORT);
    const cookie = await anmelden(benutzername, STARTPASSWORT);
    // Die erfolgreiche Anmeldung setzt nur die Bremse zurück
    const bleibt = { ...gesetzt, fehlversuche: 0, naechsterVersuchAb: null };
    const leer = {
      mussPasswortAendern: false,
      startpasswortGueltigBis: null,
      fehlversuche: 0,
      naechsterVersuchAb: null,
      deaktiviertAm: null,
      telefon: null,
      pushProgramme: false,
      pushAnmeldungen: false,
      einwilligungAm: null,
      einwilligungVersion: null,
    };

    const direkt = anfrage("update-user", {
      cookie,
      body: { name: "Direkt", ...leer },
    });
    direkt.headers.set("origin", APP);
    expect((await auth.handler(direkt)).status).toBe(200);
    expect(person(id)).toMatchObject({ name: "Direkt", ...bleibt });

    await auth.api.updateUser({
      headers: new Headers({ cookie }),
      body: { name: "Ueber api", ...leer },
    });
    expect(person(id)).toMatchObject({ name: "Ueber api", ...bleibt });
  });
});

describe("Admin-Funktionen über auth.api mit eigenen Zugriffsrollen ohne impersonate", () => {
  const aufrufe = {
    createUser: (headers: Headers | undefined) =>
      auth.api.createUser({
        headers,
        body: {
          email: `${randomUUID()}@example.org`,
          password: PASSWORT,
          name: "Neue Person",
          role: "admin",
          data: { username: `neu${++laufnummer}` },
        },
      }),
    setUserPassword: (headers: Headers | undefined, userId: string) =>
      auth.api.setUserPassword({ headers, body: { userId, newPassword: NEU } }),
    revokeUserSessions: (headers: Headers | undefined, userId: string) =>
      auth.api.revokeUserSessions({ headers, body: { userId } }),
    banUser: (headers: Headers | undefined, userId: string) =>
      auth.api.banUser({ headers, body: { userId } }),
    unbanUser: (headers: Headers | undefined, userId: string) =>
      auth.api.unbanUser({ headers, body: { userId } }),
    removeUser: (headers: Headers | undefined, userId: string) =>
      auth.api.removeUser({ headers, body: { userId } }),
    impersonateUser: (headers: Headers | undefined, userId: string) =>
      auth.api.impersonateUser({ headers, body: { userId } }),
  };

  test.each(Object.keys(aufrufe) as (keyof typeof aufrufe)[])(
    "%s mit den Headern einer normalen Person liefert 403",
    async (name) => {
      const normal = await legeAn();
      const ziel = await legeAn();
      const headers = new Headers({
        cookie: await anmelden(normal.benutzername),
      });
      await expect(aufrufe[name](headers, ziel.id)).rejects.toMatchObject({
        statusCode: 403,
      });
    },
  );

  test("impersonateUser liefert auch mit den Headern des Admins 403", async () => {
    const admin = await legeAn("admin");
    const ziel = await legeAn();
    const headers = new Headers({ cookie: await anmelden(admin.benutzername) });
    await expect(
      aufrufe.impersonateUser(headers, ziel.id),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { code: "YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS" },
    });
  });

  test("ohne Header übergeht createUser die Rechteprüfung, die übrigen liefern 401", async () => {
    const ziel = await legeAn();
    const { user } = await aufrufe.createUser(undefined);
    expect(person(user.id)).toBeDefined();
    for (const name of [
      "setUserPassword",
      "revokeUserSessions",
      "banUser",
      "unbanUser",
      "removeUser",
    ] as const) {
      await expect(aufrufe[name](undefined, ziel.id)).rejects.toMatchObject({
        statusCode: 401,
      });
    }
  });

  test("mit den Headern des Admins: createUser, setUserPassword gefolgt von revokeUserSessions, banUser, unbanUser, removeUser", async () => {
    const admin = await legeAn("admin");
    const ziel = await legeAn();
    const headers = new Headers({ cookie: await anmelden(admin.benutzername) });

    // Mit role prüft createUser zusätzlich das Recht set-role
    const { user } = await aufrufe.createUser(headers);
    expect(person(user.id)).toMatchObject({ role: "admin" });

    const vorher = await anmelden(ziel.benutzername);
    await aufrufe.setUserPassword(headers, ziel.id);
    expect(await sitzungZu(vorher)).not.toBeNull();
    await aufrufe.revokeUserSessions(headers, ziel.id);
    expect(await sitzungZu(vorher)).toBeNull();
    expect(sitzungenVon(ziel.id)).toEqual([]);

    const neu = await anmelden(ziel.benutzername, NEU);
    await aufrufe.banUser(headers, ziel.id);
    expect(await sitzungZu(neu)).toBeNull();
    // Über auth.handler: Die Route macht aus dem 403 die eine 401-Meldung
    const gesperrt = await auth.handler(
      anfrage("sign-in/username", {
        body: { username: ziel.benutzername, password: NEU },
      }),
    );
    expect(gesperrt.status).toBe(403);
    expect((await gesperrt.json()).code).toBe("BANNED_USER");

    await aufrufe.unbanUser(headers, ziel.id);
    await anmelden(ziel.benutzername, NEU);

    await aufrufe.removeUser(headers, ziel.id);
    expect(person(ziel.id)).toBeUndefined();
    expect(sitzungenVon(ziel.id)).toEqual([]);
  });
});

describe("databaseHooks.session.create.before und die Hooks auf change-password", () => {
  const TAG = 86_400_000;

  // Direkt über auth.handler: Die Route macht aus jedem 4xx der Anmeldung die eine 401-Meldung, hier zählen die inneren Codes
  test("abgelaufenes Startpasswort: falsches Passwort liefert das übliche 401, erst das richtige 403 STARTPASSWORT_ABGELAUFEN, ohne Sitzung", async () => {
    const { id, benutzername } = await legeAn(
      "user",
      {
        mussPasswortAendern: true,
        startpasswortGueltigBis: new Date(Date.now() - 1000),
      },
      STARTPASSWORT,
    );

    const falsch = await auth.handler(
      anfrage("sign-in/username", {
        body: { username: benutzername, password: NEU },
      }),
    );
    expect(falsch.status).toBe(401);
    expect((await falsch.json()).code).toBe("INVALID_USERNAME_OR_PASSWORD");

    const richtig = await auth.handler(
      anfrage("sign-in/username", {
        body: { username: benutzername, password: STARTPASSWORT },
      }),
    );
    expect(richtig.status).toBe(403);
    expect(await richtig.json()).toMatchObject({
      code: "STARTPASSWORT_ABGELAUFEN",
      message:
        "Das Startpasswort ist abgelaufen. Ein Admin kann ein neues setzen.",
    });
    expect(cookiesAus(richtig)).toBe("");
    expect(sitzungenVon(id)).toEqual([]);
  });

  test.each([
    ["null", null],
    ["ungültig", "kein Datum"],
    [
      "in der Vergangenheit, als ISO-Text im Speicher",
      new Date(Date.now() - 1000).toISOString(),
    ],
  ])(
    "mussPasswortAendern mit Ablaufdatum %s: Anmeldung liefert 403 STARTPASSWORT_ABGELAUFEN, ohne Sitzung",
    async (_, ablauf) => {
      const { id, benutzername } = await legeAn(
        "user",
        { mussPasswortAendern: true },
        STARTPASSWORT,
      );
      person(id).startpasswortGueltigBis = ablauf;
      const antwort = await auth.handler(
        anfrage("sign-in/username", {
          body: { username: benutzername, password: STARTPASSWORT },
        }),
      );
      expect(antwort.status).toBe(403);
      expect((await antwort.json()).code).toBe("STARTPASSWORT_ABGELAUFEN");
      expect(sitzungenVon(id)).toEqual([]);
    },
  );

  test("mussPasswortAendern mit künftigem Ablaufdatum als ISO-Text im Speicher: Anmeldung geht", async () => {
    const { id, benutzername } = await legeAn(
      "user",
      { mussPasswortAendern: true },
      STARTPASSWORT,
    );
    person(id).startpasswortGueltigBis = new Date(
      Date.now() + 7 * TAG,
    ).toISOString();
    await anmelden(benutzername, STARTPASSWORT);
  });

  test("das Sitzungs-Cookie einer anderen Person hebt die Prüfung bei der Anmeldung nicht auf", async () => {
    const andere = await anmelden((await legeAn()).benutzername);
    const { id, benutzername } = await legeAn(
      "user",
      {
        mussPasswortAendern: true,
        startpasswortGueltigBis: new Date(Date.now() - 1000),
      },
      STARTPASSWORT,
    );
    // Mit Cookie prüft better-auth die Herkunft auch direkt über auth.handler
    const eingang = anfrage("sign-in/username", {
      cookie: andere,
      body: { username: benutzername, password: STARTPASSWORT },
    });
    eingang.headers.set("origin", APP);
    const antwort = await auth.handler(eingang);
    expect(antwort.status).toBe(403);
    expect((await antwort.json()).code).toBe("STARTPASSWORT_ABGELAUFEN");
    expect(sitzungenVon(id)).toEqual([]);
  });

  test.each(["verify-totp", "verify-backup-code"])(
    "läuft das Startpasswort im zweiten Schritt der Anmeldung ab, liefert two-factor/%s 403 STARTPASSWORT_ABGELAUFEN, ohne Sitzung",
    async (pfad) => {
      const admin = await adminMitTotp(
        {
          mussPasswortAendern: true,
          startpasswortGueltigBis: new Date(Date.now() + 7 * TAG),
        },
        STARTPASSWORT,
      );
      await app.request(anfrage("sign-out", { cookie: admin.neuesCookie }));
      const anmeldung = await app.request(
        anfrage("sign-in/username", {
          body: { username: admin.benutzername, password: STARTPASSWORT },
        }),
      );
      expect(await anmeldung.json()).toMatchObject({ twoFactorRedirect: true });
      person(admin.id).startpasswortGueltigBis = new Date(Date.now() - 1000);

      const code =
        pfad === "verify-totp"
          ? await totpCode(admin.id)
          : admin.backupCodes[0];
      const antwort = await app.request(
        anfrage(`two-factor/${pfad}`, {
          cookie: cookiesAus(anmeldung),
          body: { code },
        }),
      );
      expect(antwort.status).toBe(403);
      expect((await antwort.json()).code).toBe("STARTPASSWORT_ABGELAUFEN");
      expect(sitzungenVon(admin.id)).toEqual([]);
    },
  );

  test("läuft das Startpasswort während einer Admin-Sitzung ab, schaltet verify-totp in dieser Sitzung den zweiten Faktor trotzdem ein", async () => {
    const admin = await legeAn(
      "admin",
      {
        mussPasswortAendern: true,
        startpasswortGueltigBis: new Date(Date.now() + 7 * TAG),
      },
      STARTPASSWORT,
    );
    const cookie = await anmelden(admin.benutzername, STARTPASSWORT);
    person(admin.id).startpasswortGueltigBis = new Date(Date.now() - 1000);

    const { neuesCookie } = await totpEinschalten(
      admin.id,
      cookie,
      STARTPASSWORT,
    );
    expect(person(admin.id).twoFactorEnabled).toBe(true);
    expect(db.twoFactor).toEqual([
      expect.objectContaining({ userId: admin.id, verified: true }),
    ]);
    expect(neuesCookie).toContain(TOKEN);
    expect(neuesCookie).not.toBe(cookie);
    expect(await sitzungZu(neuesCookie)).not.toBeNull();
  });

  test("läuft das Startpasswort während der Sitzung ab, geht change-password trotzdem; danach ist mussPasswortAendern gelöscht", async () => {
    const { id, benutzername } = await legeAn(
      "user",
      {
        mussPasswortAendern: true,
        startpasswortGueltigBis: new Date(Date.now() + 7 * TAG),
        startpasswortVerschluesselt: "irgendwas",
      },
      STARTPASSWORT,
    );
    const cookie = await anmelden(benutzername, STARTPASSWORT);
    person(id).startpasswortGueltigBis = new Date(Date.now() - 1000);

    const antwort = await app.request(
      anfrage("change-password", {
        cookie,
        body: { currentPassword: STARTPASSWORT, newPassword: NEU },
      }),
    );
    expect(antwort.status).toBe(200);
    expect(person(id).mussPasswortAendern).toBe(false);
    expect(person(id).startpasswortVerschluesselt).toBeNull();
    expect(await sitzungZu(cookiesAus(antwort))).not.toBeNull();
    await anmelden(benutzername, NEU);
  });

  test("ein fehlgeschlagener Wechsel lässt mussPasswortAendern stehen", async () => {
    const { id, benutzername } = await legeAn(
      "user",
      {
        mussPasswortAendern: true,
        startpasswortGueltigBis: new Date(Date.now() + 7 * TAG),
      },
      STARTPASSWORT,
    );
    const cookie = await anmelden(benutzername, STARTPASSWORT);

    const antwort = await app.request(
      anfrage("change-password", {
        cookie,
        body: { currentPassword: "nicht-das-passwort", newPassword: NEU },
      }),
    );
    expect(antwort.status).toBe(400);
    expect((await antwort.json()).code).toBe("INVALID_PASSWORD");
    expect(person(id).mussPasswortAendern).toBe(true);
  });

  test("change-password lehnt ein neues Passwort gleich dem bisherigen mit 400 PASSWORT_UNVERAENDERT ab", async () => {
    const cookie = await anmelden((await legeAn()).benutzername);
    const antwort = await app.request(
      anfrage("change-password", {
        cookie,
        body: { currentPassword: PASSWORT, newPassword: PASSWORT },
      }),
    );
    expect(antwort.status).toBe(400);
    expect(await antwort.json()).toMatchObject({
      code: "PASSWORT_UNVERAENDERT",
      message: "Das neue Passwort muss sich vom bisherigen unterscheiden.",
    });
  });

  test("change-password beendet alle anderen Sitzungen, auch mit revokeOtherSessions: false", async () => {
    const { id, benutzername } = await legeAn();
    const hier = await anmelden(benutzername);
    const anderswo = await anmelden(benutzername);

    const antwort = await app.request(
      anfrage("change-password", {
        cookie: hier,
        body: {
          currentPassword: PASSWORT,
          newPassword: NEU,
          revokeOtherSessions: false,
        },
      }),
    );
    expect(antwort.status).toBe(200);
    const neu = cookiesAus(antwort);
    expect(neu).toContain(TOKEN);
    expect(await sitzungZu(anderswo)).toBeNull();
    expect(await sitzungZu(hier)).toBeNull();
    expect(await sitzungZu(neu)).not.toBeNull();
    expect(sitzungenVon(id)).toHaveLength(1);
  });
});

describe("Sitzungen ohne IP-Adresse und User-Agent, ohne session.cookieCache", () => {
  test("die gespeicherte Sitzung hat weder IP-Adresse noch User-Agent, obwohl beide mitkommen", async () => {
    const { id, benutzername } = await legeAn();
    const eingang = anfrage("sign-in/username", {
      body: { username: benutzername, password: PASSWORT },
    });
    // Dokumentationsadresse aus RFC 5737
    eingang.headers.set("x-forwarded-for", "203.0.113.7");
    eingang.headers.set("user-agent", "Testgeraet/1.0");
    expect((await app.request(eingang)).status).toBe(200);
    expect(sitzungenVon(id)).toEqual([
      expect.objectContaining({ ipAddress: null, userAgent: null }),
    ]);
  });

  test("weder Anmeldung noch get-session setzen ein session_data-Cookie", async () => {
    expect((await auth.$context).options).not.toHaveProperty(
      "session.cookieCache",
    );
    const { benutzername } = await legeAn();
    const anmeldung = await app.request(
      anfrage("sign-in/username", {
        body: { username: benutzername, password: PASSWORT },
      }),
    );
    const sitzung = await app.request(
      anfrage("get-session", { methode: "GET", cookie: cookiesAus(anmeldung) }),
    );
    for (const antwort of [anmeldung, sitzung]) {
      expect(antwort.headers.getSetCookie().join()).not.toContain(
        "session_data",
      );
    }
  });

  test("nach revoke-sessions bekommt das alte Cookie sofort keine Sitzung mehr", async () => {
    const { id, benutzername } = await legeAn();
    const hier = await anmelden(benutzername);
    const anderswo = await anmelden(benutzername);
    const antwort = await app.request(
      anfrage("revoke-sessions", { cookie: hier }),
    );
    expect(antwort.status).toBe(200);
    expect(await sitzungZu(hier)).toBeNull();
    expect(await sitzungZu(anderswo)).toBeNull();
    expect(sitzungenVon(id)).toEqual([]);
  });
});

describe("Kaltstart der App mit parallelen Anfragen", () => {
  test("sechs parallele get-session mit einem Cookie, während die Verlängerung fällig ist: alle 200, gleiches Token, eine Sitzung", async () => {
    const { id, benutzername } = await legeAn();
    const cookie = await anmelden(benutzername);
    const [gespeichert] = sitzungenVon(id);
    const { updateAge } = (await auth.$context).sessionConfig;
    const faellig = new Date(
      gespeichert.expiresAt.getTime() - (updateAge + 60) * 1000,
    );
    gespeichert.expiresAt = faellig;

    const antworten = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.request(anfrage("get-session", { methode: "GET", cookie })),
      ),
    );
    for (const antwort of antworten) {
      expect(antwort.status).toBe(200);
      expect((await antwort.json()).session.token).toBe(gespeichert.token);
    }
    // Wer ein Cookie setzt, setzt dasselbe; keine Antwort lässt es ablaufen
    const gesetzt = antworten.flatMap((a) => a.headers.getSetCookie());
    expect(gesetzt.length).toBeGreaterThan(0);
    for (const c of gesetzt) expect(c.split(";")[0]).toBe(cookie);
    expect(sitzungenVon(id)).toHaveLength(1);
    expect(sitzungenVon(id)[0].expiresAt.getTime()).toBeGreaterThan(
      faellig.getTime(),
    );
  });
});

describe("Abmelden", () => {
  test("sign-out lässt das Sitzungs-Cookie ablaufen und löscht die Sitzung", async () => {
    const { id, benutzername } = await legeAn();
    const cookie = await anmelden(benutzername);
    const antwort = await app.request(anfrage("sign-out", { cookie }));
    expect(antwort.status).toBe(200);
    expect(antwort.headers.getSetCookie()).toContainEqual(
      expect.stringMatching(new RegExp(`^${TOKEN}=;.*Max-Age=0`)),
    );
    expect(cookiesAus(antwort)).toBe("");
    expect(sitzungenVon(id)).toEqual([]);
    expect(await sitzungZu(cookie)).toBeNull();
  });
});

describe("Zweiter Faktor (TOTP) im Login des Expo-Clients", () => {
  test("ein Admin richtet TOTP über die Positivliste ein; ein verify-totp in derselben Sitzung schaltet ihn ein und ersetzt das Cookie", async () => {
    const admin = await adminMitTotp();
    // Der otpauth-Link nennt den Benutzernamen als Konto, nie die E-Mail-Adresse
    expect(decodeURIComponent(admin.totpURI)).toContain(
      `:${admin.benutzername}?`,
    );
    expect(admin.totpURI).not.toContain(
      encodeURIComponent(person(admin.id).email),
    );
    expect(admin.backupCodes).toHaveLength(10);
    expect(person(admin.id).twoFactorEnabled).toBe(true);
    expect(db.twoFactor).toEqual([
      expect.objectContaining({ userId: admin.id, verified: true }),
    ]);
    expect(admin.neuesCookie).toContain(TOKEN);
    expect(admin.neuesCookie).not.toBe(admin.cookie);
    expect(await sitzungZu(admin.cookie)).toBeNull();
    expect(await sitzungZu(admin.neuesCookie)).not.toBeNull();
  });

  test("Anmeldung: sign-in/username liefert twoFactorRedirect und das two_factor-Cookie, aber keine Sitzung; verify-totp damit meldet an", async () => {
    const admin = await adminMitTotp();
    await app.request(anfrage("sign-out", { cookie: admin.neuesCookie }));

    const anmeldung = await app.request(
      anfrage("sign-in/username", {
        body: { username: admin.benutzername, password: PASSWORT },
      }),
    );
    expect(anmeldung.status).toBe(200);
    expect(await anmeldung.json()).toEqual({
      twoFactorRedirect: true,
      twoFactorMethods: ["totp"],
    });
    const zwischen = cookiesAus(anmeldung);
    expect(zwischen).toMatch(/^__Secure-better-auth\.two_factor=[^;]+$/);
    expect(sitzungenVon(admin.id)).toEqual([]);

    const antwort = await app.request(
      anfrage("two-factor/verify-totp", {
        cookie: zwischen,
        body: { code: await totpCode(admin.id) },
      }),
    );
    expect(antwort.status).toBe(200);
    expect((await sitzungZu(cookiesAus(antwort))).user.id).toBe(admin.id);
  });

  test("Anmeldung mit einem Ersatzcode", async () => {
    const admin = await adminMitTotp();
    const anmeldung = await app.request(
      anfrage("sign-in/username", {
        body: { username: admin.benutzername, password: PASSWORT },
      }),
    );
    const antwort = await app.request(
      anfrage("two-factor/verify-backup-code", {
        cookie: cookiesAus(anmeldung),
        body: { code: admin.backupCodes[0] },
      }),
    );
    expect(antwort.status).toBe(200);
    expect((await sitzungZu(cookiesAus(antwort))).user.id).toBe(admin.id);
  });

  test.each(["verify-totp", "verify-backup-code"])(
    "%s nimmt trustDevice an, setzt aber kein trust_device-Cookie: Der nächste Login fragt wieder nach dem Code",
    async (pfad) => {
      const admin = await adminMitTotp();
      const anmelden2 = () =>
        app.request(
          anfrage("sign-in/username", {
            body: { username: admin.benutzername, password: PASSWORT },
          }),
        );
      const code =
        pfad === "verify-totp"
          ? await totpCode(admin.id)
          : admin.backupCodes[0];
      const antwort = await app.request(
        anfrage(`two-factor/${pfad}`, {
          cookie: cookiesAus(await anmelden2()),
          body: { code, trustDevice: true },
        }),
      );
      expect(antwort.status).toBe(200);
      expect(cookiesAus(antwort)).not.toContain("trust_device");
      const naechste = await anmelden2();
      expect(await naechste.json()).toMatchObject({ twoFactorRedirect: true });
      expect(cookiesAus(naechste)).not.toContain(TOKEN);
    },
  );

  test("ein TOTP-Code gilt in seinem Zeitfenster mehr als einmal", async () => {
    const admin = await adminMitTotp();
    const code = await totpCode(admin.id);
    const mitCode = async () => {
      const anmeldung = await app.request(
        anfrage("sign-in/username", {
          body: { username: admin.benutzername, password: PASSWORT },
        }),
      );
      return app.request(
        anfrage("two-factor/verify-totp", {
          cookie: cookiesAus(anmeldung),
          body: { code },
        }),
      );
    };
    expect((await mitCode()).status).toBe(200);
    expect((await mitCode()).status).toBe(200);
  });
});

describe("haveIBeenPwned", () => {
  test("change-password lehnt ein Passwort aus einem Datenleck mit 400 PASSWORD_COMPROMISED ab", async () => {
    const cookie = await anmelden((await legeAn()).benutzername);
    const antwort = await app.request(
      anfrage("change-password", {
        cookie,
        body: { currentPassword: PASSWORT, newPassword: GELEAKT },
      }),
    );
    expect(antwort.status).toBe(400);
    expect((await antwort.json()).code).toBe("PASSWORD_COMPROMISED");
  });

  test.each([
    [
      "antwortet der Dienst mit einem Fehler",
      "Failed to check password. Status: 503",
      () =>
        vi
          .mocked(fetch)
          .mockResolvedValueOnce(new Response(null, { status: 503 })),
    ],
    [
      "ist der Dienst nicht erreichbar",
      "Failed to check password. Please try again later.",
      () =>
        vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed")),
    ],
  ])("%s, scheitert change-password mit 500", async (_, meldung, stoerung) => {
    const cookie = await anmelden((await legeAn()).benutzername);
    stoerung();
    const antwort = await app.request(
      anfrage("change-password", {
        cookie,
        body: { currentPassword: PASSWORT, newPassword: NEU },
      }),
    );
    expect(antwort.status).toBe(500);
    expect((await antwort.json()).message).toBe(meldung);
  });

  test("createUser mit einem Passwort aus einem Datenleck liefert 400, legt die Person aber ohne Konto an; ein zweiter Versuch scheitert an der E-Mail-Adresse", async () => {
    const email = `${randomUUID()}@example.org`;
    const anlegen = (password: string) =>
      auth.api.createUser({
        body: {
          email,
          password,
          name: "Testperson",
          data: { username: `neu${++laufnummer}` },
        },
      });
    await expect(anlegen(GELEAKT)).rejects.toMatchObject({
      statusCode: 400,
      body: { code: "PASSWORD_COMPROMISED" },
    });
    expect(db.user).toEqual([expect.objectContaining({ email })]);
    expect(db.account).toEqual([]);
    await expect(anlegen(PASSWORT)).rejects.toMatchObject({
      statusCode: 400,
      body: { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" },
    });
  });
});

describe("Grundeinstellungen", () => {
  test("sign-up/email ist auch direkt über auth.handler gesperrt", async () => {
    const antwort = await auth.handler(
      anfrage("sign-up/email", {
        body: {
          email: `${randomUUID()}@example.org`,
          password: PASSWORT,
          name: "Neu",
        },
      }),
    );
    expect(antwort.status).toBe(400);
    expect((await antwort.json()).code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
    expect(db.user).toEqual([]);
  });

  test("ein neues Passwort mit 11 Zeichen liefert 400", async () => {
    const cookie = await anmelden((await legeAn()).benutzername);
    const antwort = await app.request(
      anfrage("change-password", {
        cookie,
        body: { currentPassword: PASSWORT, newPassword: "elf-zeichen" },
      }),
    );
    expect(antwort.status).toBe(400);
    expect((await antwort.json()).code).toBe("PASSWORD_TOO_SHORT");
  });

  test("createUser prüft die Mindestlänge nicht: ein Startpasswort mit 11 Zeichen geht und meldet an", async () => {
    const { benutzername } = await legeAn("user", {}, "elf-zeichen");
    await anmelden(benutzername, "elf-zeichen");
  });

  test("Anmeldung ohne bestätigte E-Mail-Adresse geht", async () => {
    const { id, benutzername } = await legeAn();
    expect(person(id).emailVerified).toBe(false);
    await anmelden(benutzername);
  });

  test("auth.api.deleteUser mit Passwort löscht die Person", async () => {
    const { id, benutzername } = await legeAn();
    const cookie = await anmelden(benutzername);
    await auth.api.deleteUser({
      headers: new Headers({ cookie }),
      body: { password: PASSWORT },
    });
    expect(person(id)).toBeUndefined();
  });

  test("auth.api.deleteUser löscht auch ohne Passwort, solange die Sitzung jünger als 24 Stunden ist", async () => {
    expect((await auth.$context).sessionConfig.freshAge).toBe(86_400);
    const { id, benutzername } = await legeAn();
    const cookie = await anmelden(benutzername);
    await auth.api.deleteUser({ headers: new Headers({ cookie }), body: {} });
    expect(person(id)).toBeUndefined();
  });

  test("alle IDs sind UUIDs", async () => {
    const admin = await adminMitTotp();
    await app.request(
      anfrage("sign-in/username", {
        body: { username: admin.benutzername, password: PASSWORT },
      }),
    );
    for (const zeilen of Object.values(db)) {
      expect(zeilen.length).toBeGreaterThan(0);
      for (const zeile of zeilen) expect(zeile.id).toMatch(UUID);
    }
  });

  test("der Validator von username lehnt ein Ausrufezeichen ab: createUser 400, Anmeldung 422", async () => {
    await expect(
      auth.api.createUser({
        body: {
          email: `${randomUUID()}@example.org`,
          password: PASSWORT,
          name: "Testperson",
          data: { username: "mit!zeichen" },
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      body: { code: "INVALID_USERNAME" },
    });
    // Über auth.handler: Die Route macht aus dem 422 die eine 401-Meldung
    const antwort = await auth.handler(
      anfrage("sign-in/username", {
        body: { username: "mit!zeichen", password: PASSWORT },
      }),
    );
    expect(antwort.status).toBe(422);
  });
});
