import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
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
let slA: PersonaKonto;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  admin = await legePersonaAn(welt, "admin");
  slA = await legePersonaAn(welt, "slA");
});

// Jede Anfrage schreibt sonst eine Log-Zeile in die Testausgabe
let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

const STARTPASSWORT_FORM =
  /^[2-9ACDEFGHJKMNPQRTUVWXY]{4}(-[2-9ACDEFGHJKMNPQRTUVWXY]{4}){2}$/;

type Art = "kind" | "leitung" | "stufenleitung" | "auslassen";
interface Zeile {
  vorname: string;
  nachname: string;
  art: Art;
}

function anfrage(
  konto: PersonaKonto,
  pfad: "" | "/vorschau",
  body: Record<string, unknown>,
) {
  return app.request(`/api/v1/admin/import${pfad}`, {
    method: "POST",
    headers: { ...konto.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const body = (zeilen: Zeile[], stufeId = welt.stufeAId) => ({
  stufeId,
  zeilen,
});

// Nur Buchstaben: Der Benutzername entsteht aus dem Namen
const buchstaben = () =>
  randomUUID()
    .replace(/[^a-f]/g, "")
    .slice(0, 8)
    .padEnd(4, "x");
const neuerName = (art: Art): Zeile => ({
  vorname: `Vor${buchstaben()}`,
  nachname: `Nach${buchstaben()}`,
  art,
});

const zaehle = async () => ({
  kinder: (
    await db
      .select({ id: schema.kind.id })
      .from(schema.kind)
      .where(eq(schema.kind.abteilungId, welt.testabteilungId))
  ).length,
  konten: (
    await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.abteilungId, welt.testabteilungId))
  ).length,
  audit: (
    await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.abteilungId, welt.testabteilungId))
  ).length,
});

interface Vorschau {
  zeilen: {
    nr: number;
    status: string;
    art: string;
    benutzername?: string;
    grund?: string;
  }[];
  summe: Record<string, number>;
}
interface Ergebnis {
  kinder: number;
  leitende: { name: string; benutzername: string; startpasswort: string }[];
  uebersprungen: number;
}

describe("POST /api/v1/admin/import/vorschau", () => {
  test("zeigt je Zeile den Status, Benutzernamen für neue Leitende, und schreibt nichts", async () => {
    const kind = neuerName("kind");
    const leitung = neuerName("leitung");
    const vorhandenesKind = neuerName("kind");
    await db.insert(schema.kind).values({
      abteilungId: welt.testabteilungId,
      stufeId: welt.stufeBId,
      vorname: vorhandenesKind.vorname.toUpperCase(),
      nachname: ` ${vorhandenesKind.nachname} `,
    });
    const vorher = await zaehle();
    const antwort = await anfrage(
      admin,
      "/vorschau",
      body([
        kind,
        { ...kind, vorname: kind.vorname.toLowerCase() },
        leitung,
        vorhandenesKind,
        { vorname: "  ", nachname: "Leer", art: "kind" },
        { ...neuerName("kind"), vorname: "x".repeat(101) },
        neuerName("auslassen"),
      ]),
    );
    expect(antwort.status).toBe(200);
    const erg = (await antwort.json()) as Vorschau;
    expect(erg.zeilen.map((z) => [z.nr, z.status, z.art])).toEqual([
      [0, "neu", "kind"],
      [1, "doppelt", "kind"],
      [2, "neu", "leitung"],
      [3, "vorhanden", "kind"],
      [4, "ungueltig", "kind"],
      [5, "ungueltig", "kind"],
      [6, "ausgelassen", "auslassen"],
    ]);
    expect(erg.zeilen[2].benutzername).toBe(
      `${leitung.vorname}.${leitung.nachname}`.toLowerCase(),
    );
    expect(erg.zeilen[0].benutzername).toBeUndefined();
    expect(erg.zeilen[4].grund).toBeTruthy();
    expect(erg.summe).toEqual({
      neu: 2,
      vorhanden: 1,
      doppelt: 1,
      ungueltig: 2,
      ausgelassen: 1,
      kinder: 1,
      leitende: 1,
    });
    // Keine Namen in der Antwort ausser dem Benutzernamen
    expect(JSON.stringify(erg)).not.toContain(kind.nachname);
    expect(await zaehle()).toEqual(vorher);
  });

  test("ein Konto mit gleichem Namen ist «vorhanden», ein Kind mit gleichem Namen für Leitende nicht", async () => {
    const leitung = neuerName("leitung");
    await db.insert(schema.kind).values({
      abteilungId: welt.testabteilungId,
      stufeId: welt.stufeAId,
      vorname: leitung.vorname,
      nachname: leitung.nachname,
    });
    const antwort = await anfrage(admin, "/vorschau", body([leitung]));
    expect(((await antwort.json()) as Vorschau).zeilen[0].status).toBe("neu");

    const konto = await anfrage(admin, "", body([leitung]));
    expect(konto.status).toBe(201);
    const nochmal = await anfrage(admin, "/vorschau", body([leitung]));
    expect(((await nochmal.json()) as Vorschau).zeilen[0].status).toBe(
      "vorhanden",
    );
  });

  test("der Benutzername weicht einem bestehenden Konto und einer früheren Zeile aus; der Import vergibt dieselben", async () => {
    const basis = `ko${buchstaben()}`;
    const bestehendes = await app.request("/api/v1/admin/personen", {
      method: "POST",
      headers: { ...admin.headers, "content-type": "application/json" },
      body: JSON.stringify({
        vorname: "Anderer",
        nachname: "Name",
        benutzername: `${basis}.test`.toUpperCase(),
        admin: false,
        rollen: [],
        elternteilVon: [],
      }),
    });
    expect(bestehendes.status).toBe(201);
    // «Ko x» und «Kox» ergeben denselben Benutzernamen, sind aber verschiedene Personen
    const zeilen: Zeile[] = [
      { vorname: basis, nachname: "Test", art: "leitung" },
      {
        vorname: `${basis.slice(0, 2)} ${basis.slice(2)}`,
        nachname: "Test",
        art: "stufenleitung",
      },
    ];
    const vorschau = (await (
      await anfrage(admin, "/vorschau", body(zeilen))
    ).json()) as Vorschau;
    expect(vorschau.zeilen.map((z) => z.benutzername)).toEqual([
      `${basis}.test2`,
      `${basis}.test3`,
    ]);
    const erg = (await (
      await anfrage(admin, "", body(zeilen))
    ).json()) as Ergebnis;
    expect(erg.leitende.map((l) => l.benutzername)).toEqual(
      vorschau.zeilen.map((z) => z.benutzername),
    );
  });

  test("mehr als 500 Zeilen, keine Zeile, fremde und unbekannte Stufe geben 400 und schreiben nichts", async () => {
    const vorher = await zaehle();
    const viele = Array.from({ length: 501 }, () => neuerName("kind"));
    for (const pfad of ["/vorschau", ""] as const) {
      expect((await anfrage(admin, pfad, body(viele))).status).toBe(400);
      expect((await anfrage(admin, pfad, body([]))).status).toBe(400);
      for (const stufeId of [welt.demoStufeId, randomUUID()]) {
        const antwort = await anfrage(
          admin,
          pfad,
          body([neuerName("kind")], stufeId),
        );
        expect(antwort.status).toBe(400);
      }
      expect(
        (await anfrage(admin, pfad, { ...body([neuerName("kind")]), x: 1 }))
          .status,
      ).toBe(400);
      expect(
        (
          await anfrage(
            admin,
            pfad,
            body([{ ...neuerName("kind"), vorname: "a".repeat(201) }]),
          )
        ).status,
      ).toBe(400);
    }
    expect(await zaehle()).toEqual(vorher);
  });

  test("genau 500 Zeilen sind erlaubt", async () => {
    const zeilen = Array.from({ length: 500 }, () => neuerName("kind"));
    expect((await anfrage(admin, "/vorschau", body(zeilen))).status).toBe(200);
  });
});

describe("POST /api/v1/admin/import", () => {
  test("legt Kinder und Leitende an, mit Startpasswort nur in der Antwort, Rolle, Audit-Eintrag", async () => {
    const kind = neuerName("kind");
    const leitung = neuerName("leitung");
    const stufenleitung = neuerName("stufenleitung");
    const vorher = await zaehle();
    const antwort = await anfrage(
      admin,
      "",
      body([kind, leitung, stufenleitung, neuerName("auslassen")]),
    );
    expect(antwort.status).toBe(201);
    const erg = (await antwort.json()) as Ergebnis;
    expect(erg.kinder).toBe(1);
    expect(erg.uebersprungen).toBe(1);
    expect(erg.leitende.map((l) => l.name)).toEqual([
      `${leitung.vorname} ${leitung.nachname}`,
      `${stufenleitung.vorname} ${stufenleitung.nachname}`,
    ]);
    const passwoerter = erg.leitende.map((l) => l.startpasswort);
    for (const p of passwoerter) expect(p).toMatch(STARTPASSWORT_FORM);
    expect(new Set(passwoerter).size).toBe(2);

    const [kindZeile] = await db
      .select()
      .from(schema.kind)
      .where(
        and(
          eq(schema.kind.abteilungId, welt.testabteilungId),
          eq(schema.kind.nachname, kind.nachname),
        ),
      );
    expect(kindZeile).toMatchObject({
      vorname: kind.vorname,
      stufeId: welt.stufeAId,
      inaktivSeit: null,
    });

    const konten = await db
      .select()
      .from(schema.user)
      .where(
        inArray(
          schema.user.username,
          erg.leitende.map((l) => l.benutzername),
        ),
      );
    expect(konten).toHaveLength(2);
    for (const k of konten) {
      expect(k).toMatchObject({
        role: "user",
        abteilungId: welt.testabteilungId,
        mussPasswortAendern: true,
      });
    }
    const rollen = await db
      .select({ typ: schema.rolle.typ, stufeId: schema.rolle.stufeId })
      .from(schema.rolle)
      .where(
        inArray(
          schema.rolle.userId,
          konten.map((k) => k.id),
        ),
      );
    expect(rollen.map((r) => r.typ).sort()).toEqual([
      "leitung",
      "stufenleitung",
    ]);
    expect(rollen.every((r) => r.stufeId === welt.stufeAId)).toBe(true);
    expect(
      await db
        .select({ id: schema.kindEltern.kindId })
        .from(schema.kindEltern)
        .where(
          inArray(
            schema.kindEltern.userId,
            konten.map((k) => k.id),
          ),
        ),
    ).toEqual([]);

    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.aktion, "person_angelegt"),
          inArray(
            schema.auditLog.zielId,
            konten.map((k) => k.id),
          ),
        ),
      );
    expect(audit).toHaveLength(2);
    for (const a of audit) {
      expect(a).toMatchObject({
        akteurId: admin.id,
        abteilungId: welt.testabteilungId,
        zielTyp: "person",
      });
      expect(a.details).toMatchObject({ admin: false, elternteilVon: [] });
    }
    const nachher = await zaehle();
    expect(nachher.audit - vorher.audit).toBe(2);

    // Startpasswort nicht im Klartext gespeichert und nicht im Log; die Liste zeigt es dem Admin (verschlüsselt abgelegt)
    const konto = await db
      .select({ password: schema.account.password })
      .from(schema.account)
      .where(eq(schema.account.userId, konten[0].id));
    const logs = ausgabe.mock.calls.flat().join(" ");
    for (const p of passwoerter) {
      expect(konto[0].password).not.toContain(p);
      expect(logs).not.toContain(p);
    }
    // Und mit dem Startpasswort kann sich die Person anmelden
    const anmeldung = await auth.api.signInUsername({
      body: {
        username: erg.leitende[0].benutzername,
        password: erg.leitende[0].startpasswort.replace(/-/g, "").toUpperCase(),
      },
      returnHeaders: true,
    });
    expect(cookiesAus(anmeldung)).not.toBe("");
  });

  test("ein zweiter Import derselben Datei legt nichts doppelt an", async () => {
    const zeilen: Zeile[] = [
      neuerName("kind"),
      neuerName("leitung"),
      neuerName("kind"),
    ];
    zeilen.push({ ...zeilen[0] });
    const erst = (await (
      await anfrage(admin, "", body(zeilen))
    ).json()) as Ergebnis;
    expect(erst).toMatchObject({ kinder: 2, uebersprungen: 1 });
    expect(erst.leitende).toHaveLength(1);
    const vorher = await zaehle();
    const antwort = await anfrage(admin, "", body(zeilen));
    expect(antwort.status).toBe(201);
    expect(await antwort.json()).toEqual({
      kinder: 0,
      leitende: [],
      uebersprungen: 4,
    });
    expect(await zaehle()).toEqual(vorher);
  });

  test("zwei gleichzeitige Importe derselben Datei legen jede Person einmal an", async () => {
    const zeilen: Zeile[] = [neuerName("kind"), neuerName("kind")];
    const antworten = await Promise.all([
      anfrage(admin, "", body(zeilen)),
      anfrage(admin, "", body(zeilen)),
    ]);
    expect(antworten.map((a) => a.status)).toEqual([201, 201]);
    const ergebnisse = (await Promise.all(
      antworten.map((a) => a.json()),
    )) as Ergebnis[];
    expect(ergebnisse.map((e) => e.kinder).sort()).toEqual([0, 2]);
  });

  test("scheitert ein Konto (HIBP), bleibt nichts zurück: weder Kinder noch Konten noch Audit", async () => {
    const zeilen: Zeile[] = [
      neuerName("kind"),
      neuerName("leitung"),
      neuerName("leitung"),
    ];
    const vorher = await zaehle();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("", { status: 503 }),
    );
    const antwort = await anfrage(admin, "", body(zeilen));
    expect(antwort.status).toBe(500);
    expect(JSON.stringify(await antwort.json())).not.toContain("startpasswort");
    expect(await zaehle()).toEqual(vorher);
    // Dieselbe Datei geht danach durch
    const nochmal = await anfrage(admin, "", body(zeilen));
    expect(nochmal.status).toBe(201);
    expect(((await nochmal.json()) as Ergebnis).kinder).toBe(1);
  });

  test("die Stufe kann auch die zweite Stufe der Abteilung sein", async () => {
    const kind = neuerName("kind");
    const antwort = await anfrage(admin, "", body([kind], welt.stufeBId));
    expect(antwort.status).toBe(201);
    const [zeile] = await db
      .select({ stufeId: schema.kind.stufeId })
      .from(schema.kind)
      .where(eq(schema.kind.nachname, kind.nachname));
    expect(zeile.stufeId).toBe(welt.stufeBId);
  });
});

describe("Rechte", () => {
  test.each(["/vorschau", ""] as const)(
    "eine Stufenleitung bekommt 403 (%s) und es wird nichts geschrieben",
    async (pfad) => {
      const vorher = await zaehle();
      const antwort = await anfrage(
        slA,
        pfad,
        body([neuerName("kind"), neuerName("leitung")]),
      );
      expect(antwort.status).toBe(403);
      expect(await zaehle()).toEqual(vorher);
    },
  );

  test("ohne Anmeldung 401", async () => {
    const antwort = await app.request("/api/v1/admin/import/vorschau", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body([neuerName("kind")])),
    });
    expect(antwort.status).toBe(401);
  });
});
