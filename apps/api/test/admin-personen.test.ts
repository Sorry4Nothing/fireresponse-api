import { randomUUID } from "node:crypto";
import { and, eq, sql as sqlAusdruck } from "drizzle-orm";
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
import { aktiveAdminIds } from "../src/admins.js";
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { ladeSeiten } from "../src/seiten.js";
import { normalisiereStartpasswort } from "../src/startpasswort.js";
import {
  bereiteAuthTestsVor,
  cookiesAus,
  erstelleTestAuth,
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
let admin: PersonaKonto;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  admin = await legePersonaAn(welt, "admin");
});

// Jede Anfrage schreibt sonst eine Log-Zeile in die Testausgabe
let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

const BASIS = "/api/v1/admin/personen";
const STARTPASSWORT_FORM =
  /^[2-9ACDEFGHJKMNPQRTUVWXY]{4}(-[2-9ACDEFGHJKMNPQRTUVWXY]{4}){2}$/;

function anfrage(
  konto: PersonaKonto,
  methode: string,
  pfad = "",
  body?: Record<string, unknown>,
) {
  return app.request(`${BASIS}${pfad}`, {
    method: methode,
    headers: body
      ? { ...konto.headers, "content-type": "application/json" }
      : konto.headers,
    body: body && JSON.stringify(body),
  });
}

const neuerBenutzername = () => `person.${randomUUID().slice(0, 8)}`;

function anlegenBody(extra: Record<string, unknown> = {}) {
  return {
    vorname: "Vreni",
    nachname: "Muster",
    benutzername: neuerBenutzername(),
    admin: false,
    rollen: [],
    elternteilVon: [],
    ...extra,
  };
}

interface Angelegt {
  id: string;
  benutzername: string;
  startpasswort: string;
}

async function legePersonAn(
  extra: Record<string, unknown> = {},
  konto = admin,
) {
  const antwort = await anfrage(konto, "POST", "", anlegenBody(extra));
  expect(antwort.status).toBe(201);
  return (await antwort.json()) as Angelegt;
}

const anmelden = (benutzername: string, passwort: string) =>
  auth.api.signInUsername({
    body: { username: benutzername, password: passwort },
    returnHeaders: true,
  });

const userZeile = async (id: string) =>
  (await db.select().from(schema.user).where(eq(schema.user.id, id)))[0];
const sitzungen = (id: string) =>
  db.select().from(schema.session).where(eq(schema.session.userId, id));

describe("POST /api/v1/admin/personen", () => {
  test("legt die Person mit Rollen und Kindern an; Benutzername mit Bindestrich und Grossbuchstaben wird kleingeschrieben gespeichert", async () => {
    const vorher = Date.now();
    const roh = `Vreni-M.${randomUUID().slice(0, 8).toUpperCase()}`;
    const angelegt = await legePersonAn({
      benutzername: roh,
      admin: true,
      rollen: [{ stufeId: welt.stufeAId, typ: "stufenleitung" }],
      elternteilVon: [welt.kindBId],
    });
    expect(angelegt.benutzername).toBe(roh.toLowerCase());
    expect(angelegt.startpasswort).toMatch(STARTPASSWORT_FORM);

    const person = await userZeile(angelegt.id);
    expect(person).toMatchObject({
      name: "Vreni Muster",
      username: roh.toLowerCase(),
      role: "admin",
      abteilungId: welt.testabteilungId,
      mussPasswortAendern: true,
      fehlversuche: 0,
      naechsterVersuchAb: null,
    });
    const gueltigBis = person.startpasswortGueltigBis!.getTime();
    expect(gueltigBis).toBeGreaterThan(vorher + 7 * 86_400_000 - 60_000);
    expect(gueltigBis).toBeLessThan(Date.now() + 7 * 86_400_000 + 60_000);

    expect(
      await db
        .select({ stufeId: schema.rolle.stufeId, typ: schema.rolle.typ })
        .from(schema.rolle)
        .where(eq(schema.rolle.userId, angelegt.id)),
    ).toEqual([{ stufeId: welt.stufeAId, typ: "stufenleitung" }]);
    expect(
      await db
        .select({ kindId: schema.kindEltern.kindId })
        .from(schema.kindEltern)
        .where(eq(schema.kindEltern.userId, angelegt.id)),
    ).toEqual([{ kindId: welt.kindBId }]);
  });

  test("mit dem Startpasswort aus der Antwort kann sich die Person anmelden", async () => {
    const angelegt = await legePersonAn();
    const anmeldung = await anmelden(
      angelegt.benutzername,
      angelegt.startpasswort,
    );
    expect(cookiesAus(anmeldung)).not.toBe("");
    expect(await sitzungen(angelegt.id)).toHaveLength(1);
  });

  test("das Startpasswort steht nicht im Klartext in account.password, in der Datenbank oder in den Logs; die Liste zeigt es nur dem Admin", async () => {
    const angelegt = await legePersonAn();
    const formen = [
      angelegt.startpasswort,
      normalisiereStartpasswort(angelegt.startpasswort),
    ];
    const [konto] = await db
      .select({ password: schema.account.password })
      .from(schema.account)
      .where(eq(schema.account.userId, angelegt.id));
    const [zeile] = await db
      .select({ chiffre: schema.user.startpasswortVerschluesselt })
      .from(schema.user)
      .where(eq(schema.user.id, angelegt.id));
    const logs = ausgabe.mock.calls.flat().join(" ");
    for (const form of formen) {
      expect(konto.password).not.toContain(form);
      expect(zeile.chiffre).not.toContain(form);
      expect(logs).not.toContain(form);
    }
  });

  test("ein vergebener Benutzername gibt 409, auch in anderer Schreibweise", async () => {
    const angelegt = await legePersonAn();
    const antwort = await anfrage(
      admin,
      "POST",
      "",
      anlegenBody({ benutzername: angelegt.benutzername.toUpperCase() }),
    );
    expect(antwort.status).toBe(409);
    expect(await antwort.json()).toEqual({
      code: "BENUTZERNAME_VERGEBEN",
      message: "Dieser Benutzername ist schon vergeben.",
    });
  });

  test.each([
    [
      "fremde Stufe",
      () => ({ rollen: [{ stufeId: welt.demoStufeId, typ: "leitung" }] }),
    ],
    [
      "unbekannte Stufe",
      () => ({ rollen: [{ stufeId: randomUUID(), typ: "leitung" }] }),
    ],
    [
      "doppelte Stufe",
      () => ({
        rollen: [
          { stufeId: welt.stufeAId, typ: "leitung" },
          { stufeId: welt.stufeAId, typ: "stufenleitung" },
        ],
      }),
    ],
    ["fremdes Kind", () => ({ elternteilVon: [welt.demoKindId] })],
    ["unbekanntes Kind", () => ({ elternteilVon: [randomUUID()] })],
    ["doppeltes Kind", () => ({ elternteilVon: [welt.kindAId, welt.kindAId] })],
    ["überzähliger Schlüssel", () => ({ telefon: "079" })],
    ["Benutzername mit !", () => ({ benutzername: "mit!zeichen" })],
    ["Benutzername mit 1 Zeichen", () => ({ benutzername: "a" })],
    ["Benutzername mit 65 Zeichen", () => ({ benutzername: "a".repeat(65) })],
  ])("%s gibt 400", async (_titel, extra) => {
    const antwort = await anfrage(admin, "POST", "", anlegenBody(extra()));
    expect(antwort.status).toBe(400);
  });

  test("scheitert HIBP, bleibt kein Konto zurück, und der Name ist noch frei", async () => {
    const body = anlegenBody();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("", { status: 503 }),
    );
    const erste = await anfrage(admin, "POST", "", body);
    expect(erste.status).toBe(500);
    expect(
      await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.username, body.benutzername as string)),
    ).toEqual([]);
    // Die Transaktion hat alles zurückgenommen: Derselbe Name geht jetzt durch
    const zweite = await anfrage(admin, "POST", "", body);
    expect(zweite.status).toBe(201);
  });
});

describe("GET /api/v1/admin/personen", () => {
  test("liefert Personen mit Rollen, Stufen und Kinder der eigenen Abteilung, ohne E-Mail", async () => {
    const angelegt = await legePersonAn({
      rollen: [{ stufeId: welt.stufeBId, typ: "leitung" }],
      elternteilVon: [welt.kindAId],
    });
    const antwort = await anfrage(admin, "GET");
    expect(antwort.status).toBe(200);
    const koerper = (await antwort.json()) as {
      personen: Record<string, unknown>[];
      stufen: { id: string }[];
      kinder: { id: string }[];
    };
    const person = koerper.personen.find((p) => p.id === angelegt.id)!;
    expect(Object.keys(person).sort()).toEqual([
      "admin",
      "benutzername",
      "bildUrl",
      "deaktiviert",
      "elternteilVon",
      "id",
      "mussPasswortAendern",
      "name",
      "rollen",
      "startpasswort",
      "startpasswortGueltigBis",
      "telefon",
      "zweiterFaktor",
    ]);
    expect(person).toMatchObject({
      admin: false,
      deaktiviert: false,
      mussPasswortAendern: true,
      rollen: [{ stufeId: welt.stufeBId, typ: "leitung" }],
      elternteilVon: [welt.kindAId],
    });
    expect(koerper.stufen.map((s) => s.id)).toEqual([
      welt.stufeAId,
      welt.stufeBId,
    ]);
    expect(koerper.kinder.map((k) => k.id).sort()).toEqual(
      [welt.kindAId, welt.kindBId].sort(),
    );
    const text = JSON.stringify(koerper);
    for (const feld of ['"email"', '"banReason"', '"fehlversuche"']) {
      expect(text).not.toContain(feld);
    }
  });

  test("der Demo-Admin sieht nur die eigene Abteilung: eigene Liste, 404 auf fremde IDs, 400 auf fremde Stufen", async () => {
    const demoAdmin = await legePersonaAn(welt, "demoAdmin");
    const fremde = await legePersonAn();
    const liste = await anfrage(demoAdmin, "GET");
    const koerper = (await liste.json()) as { personen: { id: string }[] };
    expect(koerper.personen.map((p) => p.id)).not.toContain(fremde.id);
    expect(
      (await anfrage(demoAdmin, "PATCH", `/${fremde.id}`, { name: "Fremd" }))
        .status,
    ).toBe(404);
    expect(
      (
        await anfrage(
          demoAdmin,
          "POST",
          "",
          anlegenBody({
            rollen: [{ stufeId: welt.stufeAId, typ: "leitung" }],
          }),
        )
      ).status,
    ).toBe(400);
  });
});

describe("Telefon", () => {
  const sl = () => [{ stufeId: welt.stufeAId, typ: "stufenleitung" }];
  const telefonInListe = async (id: string) =>
    (
      (await (await anfrage(admin, "GET")).json()) as {
        personen: { id: string; telefon: string | null }[];
      }
    ).personen.find((p) => p.id === id)!.telefon;

  test("wird beim Anlegen einer SL gespeichert, getrimmt, in der Liste genannt, geändert und entfernt", async () => {
    const angelegt = await legePersonAn({
      rollen: sl(),
      telefon: " +41 79 123 45 67 ",
    });
    expect((await userZeile(angelegt.id)).telefon).toBe("+41 79 123 45 67");
    expect(await telefonInListe(angelegt.id)).toBe("+41 79 123 45 67");
    const patch = (telefon: string | null) =>
      anfrage(admin, "PATCH", `/${angelegt.id}`, { telefon });
    expect((await patch("044 123 45 67")).status).toBe(204);
    expect(await telefonInListe(angelegt.id)).toBe("044 123 45 67");
    expect((await patch("")).status).toBe(204);
    expect(await telefonInListe(angelegt.id)).toBeNull();
  });

  test("ohne SL-Rolle ist eine Nummer ein 400, Entfernen geht; mit der Rolle im selben PATCH geht es", async () => {
    const eltern = await legePersonAn();
    expect(
      (
        await anfrage(admin, "PATCH", `/${eltern.id}`, {
          telefon: "044 123 45 67",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await anfrage(
          admin,
          "POST",
          "",
          anlegenBody({ telefon: "044 123 45 67" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await anfrage(admin, "PATCH", `/${eltern.id}`, {
          rollen: sl(),
          telefon: "044 123 45 67",
        })
      ).status,
    ).toBe(204);
    expect(
      (await anfrage(admin, "PATCH", `/${eltern.id}`, { telefon: "abc" }))
        .status,
    ).toBe(400);
    expect(
      (
        await anfrage(admin, "PATCH", `/${eltern.id}`, {
          rollen: [],
          telefon: null,
        })
      ).status,
    ).toBe(204);
    expect(await telefonInListe(eltern.id)).toBeNull();
  });
});

describe("PATCH /api/v1/admin/personen/:id", () => {
  test("ändert Name, Admin und Listen; unveränderte kind_eltern-Zeilen behalten erstellt_am", async () => {
    const angelegt = await legePersonAn({
      rollen: [{ stufeId: welt.stufeAId, typ: "leitung" }],
      elternteilVon: [welt.kindAId],
    });
    const [vorher] = await db
      .select({ erstelltAm: schema.kindEltern.erstelltAm })
      .from(schema.kindEltern)
      .where(
        and(
          eq(schema.kindEltern.userId, angelegt.id),
          eq(schema.kindEltern.kindId, welt.kindAId),
        ),
      );
    const antwort = await anfrage(admin, "PATCH", `/${angelegt.id}`, {
      name: "Neues Name",
      admin: true,
      rollen: [{ stufeId: welt.stufeAId, typ: "stufenleitung" }],
      elternteilVon: [welt.kindAId, welt.kindBId],
    });
    expect(antwort.status).toBe(204);
    expect(await userZeile(angelegt.id)).toMatchObject({
      name: "Neues Name",
      role: "admin",
    });
    expect(
      await db
        .select({ stufeId: schema.rolle.stufeId, typ: schema.rolle.typ })
        .from(schema.rolle)
        .where(eq(schema.rolle.userId, angelegt.id)),
    ).toEqual([{ stufeId: welt.stufeAId, typ: "stufenleitung" }]);
    const eltern = await db
      .select({
        kindId: schema.kindEltern.kindId,
        erstelltAm: schema.kindEltern.erstelltAm,
      })
      .from(schema.kindEltern)
      .where(eq(schema.kindEltern.userId, angelegt.id));
    expect(eltern.map((zeile) => zeile.kindId).sort()).toEqual(
      [welt.kindAId, welt.kindBId].sort(),
    );
    expect(
      eltern.find((zeile) => zeile.kindId === welt.kindAId)!.erstelltAm,
    ).toEqual(vorher.erstelltAm);
  });

  test("das eigene Konto darf den Namen per PATCH ändern", async () => {
    const antwort = await anfrage(admin, "PATCH", `/${admin.id}`, {
      name: "Admin Umbenannt",
    });
    expect(antwort.status).toBe(204);
  });
});

describe("Startpasswort in der Personenliste", () => {
  const holeListe = async (id: string) => {
    const antwort = await anfrage(admin, "GET");
    const { personen } = (await antwort.json()) as {
      personen: { id: string; startpasswort: string | null }[];
    };
    return personen.find((p) => p.id === id)!.startpasswort;
  };

  test("zeigt ein offenes Startpasswort, ein neues ersetzt es, nach Wechsel oder Ablauf nichts mehr", async () => {
    const angelegt = await legePersonAn();
    expect(await holeListe(angelegt.id)).toBe(angelegt.startpasswort);

    const neu = (await (
      await anfrage(admin, "POST", `/${angelegt.id}/startpasswort`)
    ).json()) as { startpasswort: string };
    expect(await holeListe(angelegt.id)).toBe(neu.startpasswort);

    await db
      .update(schema.user)
      .set({ startpasswortGueltigBis: new Date(Date.now() - 1000) })
      .where(eq(schema.user.id, angelegt.id));
    expect(await holeListe(angelegt.id)).toBeNull();

    await db
      .update(schema.user)
      .set({
        startpasswortGueltigBis: new Date(Date.now() + 1000),
        mussPasswortAendern: false,
      })
      .where(eq(schema.user.id, angelegt.id));
    expect(await holeListe(angelegt.id)).toBeNull();
  });

  test("in der Datenbank liegt es nur verschlüsselt", async () => {
    const angelegt = await legePersonAn();
    const zeile = await userZeile(angelegt.id);
    expect(zeile.startpasswortVerschluesselt).toBeTruthy();
    expect(zeile.startpasswortVerschluesselt).not.toContain(
      angelegt.startpasswort,
    );
  });
});

describe("POST /api/v1/admin/personen/:id/startpasswort", () => {
  test("beendet alle Sitzungen, setzt Flag, Frist und Bremse zurück; das alte Passwort gilt nicht mehr", async () => {
    const angelegt = await legePersonAn();
    await anmelden(angelegt.benutzername, angelegt.startpasswort);
    // Eine angelaufene Bremse, die das neue Startpasswort zurücksetzen muss
    await db
      .update(schema.user)
      .set({
        fehlversuche: 4,
        naechsterVersuchAb: new Date(Date.now() + 60_000),
      })
      .where(eq(schema.user.id, angelegt.id));

    const vorher = Date.now();
    const antwort = await anfrage(
      admin,
      "POST",
      `/${angelegt.id}/startpasswort`,
    );
    expect(antwort.status).toBe(200);
    const { startpasswort } = (await antwort.json()) as {
      startpasswort: string;
    };
    expect(startpasswort).toMatch(STARTPASSWORT_FORM);
    expect(startpasswort).not.toBe(angelegt.startpasswort);

    expect(await sitzungen(angelegt.id)).toEqual([]);
    const person = await userZeile(angelegt.id);
    expect(person).toMatchObject({
      mussPasswortAendern: true,
      fehlversuche: 0,
      naechsterVersuchAb: null,
    });
    expect(person.startpasswortGueltigBis!.getTime()).toBeGreaterThan(
      vorher + 7 * 86_400_000 - 60_000,
    );
    await expect(
      anmelden(angelegt.benutzername, angelegt.startpasswort),
    ).rejects.toMatchObject({
      body: { code: "INVALID_USERNAME_OR_PASSWORD" },
    });
    await anmelden(angelegt.benutzername, startpasswort);
    expect(await sitzungen(angelegt.id)).toHaveLength(1);
  });

  test("scheitert HIBP, bleibt alles beim Alten: Passwort, Sitzung und Flag", async () => {
    const angelegt = await legePersonAn();
    await anmelden(angelegt.benutzername, angelegt.startpasswort);
    const [kontoVorher] = await db
      .select({ password: schema.account.password })
      .from(schema.account)
      .where(eq(schema.account.userId, angelegt.id));

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("", { status: 503 }),
    );
    const antwort = await anfrage(
      admin,
      "POST",
      `/${angelegt.id}/startpasswort`,
    );
    expect(antwort.status).toBe(500);

    const [kontoNachher] = await db
      .select({ password: schema.account.password })
      .from(schema.account)
      .where(eq(schema.account.userId, angelegt.id));
    expect(kontoNachher.password).toBe(kontoVorher.password);
    expect(await sitzungen(angelegt.id)).toHaveLength(1);
    await anmelden(angelegt.benutzername, angelegt.startpasswort);
    expect(await sitzungen(angelegt.id)).toHaveLength(2);
  });

  test.each([
    ["startpasswort", "POST", "/startpasswort"],
    ["deaktivieren", "POST", "/deaktivieren"],
    ["löschen", "DELETE", ""],
  ])(
    "das eigene Konto gibt bei %s 409 EIGENES_KONTO",
    async (_titel, methode, endstueck) => {
      const antwort = await anfrage(admin, methode, `/${admin.id}${endstueck}`);
      expect(antwort.status).toBe(409);
      expect(await antwort.json()).toMatchObject({ code: "EIGENES_KONTO" });
    },
  );
});

describe("Deaktivieren und Aktivieren", () => {
  test("Deaktivieren sperrt Login und löscht Sitzungen, Aktivieren öffnet wieder", async () => {
    const angelegt = await legePersonAn();
    await anmelden(angelegt.benutzername, angelegt.startpasswort);

    const deaktiviert = await anfrage(
      admin,
      "POST",
      `/${angelegt.id}/deaktivieren`,
    );
    expect(deaktiviert.status).toBe(204);
    const person = await userZeile(angelegt.id);
    expect(person.banned).toBe(true);
    expect(person.deaktiviertAm).not.toBeNull();
    expect(await sitzungen(angelegt.id)).toEqual([]);
    await expect(
      anmelden(angelegt.benutzername, angelegt.startpasswort),
    ).rejects.toMatchObject({ body: { code: "BANNED_USER" } });

    const aktiviert = await anfrage(
      admin,
      "POST",
      `/${angelegt.id}/aktivieren`,
    );
    expect(aktiviert.status).toBe(204);
    const wieder = await userZeile(angelegt.id);
    expect(wieder.banned).toBe(false);
    expect(wieder.deaktiviertAm).toBeNull();
    await anmelden(angelegt.benutzername, angelegt.startpasswort);
    expect(await sitzungen(angelegt.id)).toHaveLength(1);
  });
});

describe("DELETE /api/v1/admin/personen/:id", () => {
  test("löscht Person, Konto, Rollen, Kinder-Verknüpfungen und Sitzungen", async () => {
    const angelegt = await legePersonAn({
      rollen: [{ stufeId: welt.stufeAId, typ: "leitung" }],
      elternteilVon: [welt.kindAId],
    });
    await anmelden(angelegt.benutzername, angelegt.startpasswort);

    const antwort = await anfrage(admin, "DELETE", `/${angelegt.id}`);
    expect(antwort.status).toBe(204);
    expect(await userZeile(angelegt.id)).toBeUndefined();
    for (const tabelle of [
      schema.account,
      schema.session,
      schema.rolle,
      schema.kindEltern,
    ] as const) {
      expect(
        await db.select().from(tabelle).where(eq(tabelle.userId, angelegt.id)),
      ).toEqual([]);
    }
  });
});

// Eigene Welt pro Test: Die Fälle hängen an der genauen Zahl aktiver Admins ihrer Abteilung
describe("Schutz des letzten Admins", () => {
  async function eigeneWelt() {
    const eigene = await erstelleWelt(db, auth);
    return {
      welt: eigene,
      ersterAdmin: await legePersonaAn(eigene, "admin"),
    };
  }

  test("der einzige Admin kann sich die Rolle nicht selbst nehmen", async () => {
    const { ersterAdmin } = await eigeneWelt();
    const antwort = await anfrage(ersterAdmin, "PATCH", `/${ersterAdmin.id}`, {
      admin: false,
    });
    expect(antwort.status).toBe(409);
    expect(await antwort.json()).toMatchObject({ code: "LETZTER_ADMIN" });
    expect((await userZeile(ersterAdmin.id!)).role).toBe("admin");
  });

  test("mit zwei Admins geht das Entfernen des einen, der letzte bleibt; deaktivierte zählen nicht", async () => {
    const { welt: eigene, ersterAdmin } = await eigeneWelt();
    const zweiter = await legePersonaAn(eigene, "adminOhneZweitenFaktor");

    // Zwei Admins: den anderen zurückstufen geht
    expect(
      (await anfrage(ersterAdmin, "PATCH", `/${zweiter.id}`, { admin: false }))
        .status,
    ).toBe(204);
    // Jetzt ist ersterAdmin allein: sich selbst zurückstufen gibt 409
    expect(
      (
        await anfrage(ersterAdmin, "PATCH", `/${ersterAdmin.id}`, {
          admin: false,
        })
      ).status,
    ).toBe(409);
    // Wieder zwei Admins, aber der zweite deaktiviert: er zählt nicht
    expect(
      (await anfrage(ersterAdmin, "PATCH", `/${zweiter.id}`, { admin: true }))
        .status,
    ).toBe(204);
    expect(
      (await anfrage(ersterAdmin, "POST", `/${zweiter.id}/deaktivieren`))
        .status,
    ).toBe(204);
    expect(
      (
        await anfrage(ersterAdmin, "PATCH", `/${ersterAdmin.id}`, {
          admin: false,
        })
      ).status,
    ).toBe(409);
  });

  test("gegenseitiges Deaktivieren über Promise.all lässt genau einen aktiven Admin übrig", async () => {
    const { welt: eigene, ersterAdmin } = await eigeneWelt();
    // Mit zweitem Faktor: Ohne ihn sperrt die Admin-Sperre (#23) seine Anfrage vor dem Rennen
    const zweiter = await legePersonaAn(eigene, "admin");

    const antworten = await Promise.all([
      anfrage(ersterAdmin, "POST", `/${zweiter.id}/deaktivieren`),
      anfrage(zweiter, "POST", `/${ersterAdmin.id}/deaktivieren`),
    ]);
    const status = antworten.map((a) => a.status).sort((a, b) => a - b);
    // 409 aus der Sperre; 401, wenn die Sitzungsprüfung des Verlierers erst nach dem fremden Commit lief
    expect([
      [204, 401],
      [204, 409],
    ]).toContainEqual(status);
    expect(await aktiveAdminIds(db, eigene.testabteilungId)).toHaveLength(1);
  });

  test("gegenseitiges Zurückstufen über Promise.all lässt genau einen aktiven Admin übrig", async () => {
    const { welt: eigene, ersterAdmin } = await eigeneWelt();
    const zweiter = await legePersonaAn(eigene, "admin");

    const antworten = await Promise.all([
      anfrage(ersterAdmin, "PATCH", `/${zweiter.id}`, { admin: false }),
      anfrage(zweiter, "PATCH", `/${ersterAdmin.id}`, { admin: false }),
    ]);
    const status = antworten.map((a) => a.status).sort((a, b) => a - b);
    // 403, wenn die Sitzung des Verlierers die Rolle erst nach dem fremden Commit las
    expect([
      [204, 403],
      [204, 409],
    ]).toContainEqual(status);
    expect(await aktiveAdminIds(db, eigene.testabteilungId)).toHaveLength(1);
  });

  test("Deaktivierte sind für die Zählung inaktiv, banned null zählt als aktiv", async () => {
    const { welt: eigene, ersterAdmin } = await eigeneWelt();
    // banned bleibt bei createUser false; null simuliert eine alte Zeile
    await db
      .update(schema.user)
      .set({ banned: sqlAusdruck`null` })
      .where(eq(schema.user.id, ersterAdmin.id!));
    expect(await aktiveAdminIds(db, eigene.testabteilungId)).toEqual([
      ersterAdmin.id,
    ]);
  });
});
