import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
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
import { bereiteAuthTestsVor, erstelleTestAuth } from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  type Persona,
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
let demoElternId: string;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  admin = await legePersonaAn(welt, "admin");
  demoElternId = (await neuerElternteil("demoEltern")).id;
});

// Jede Anfrage schreibt sonst eine Log-Zeile in die Testausgabe
let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

const BASIS = "/api/v1/admin/kinder";

function anfrage(
  konto: PersonaKonto,
  methode: string,
  pfad: string,
  body?: Record<string, unknown>,
) {
  return app.request(pfad, {
    method: methode,
    headers: body
      ? { ...konto.headers, "content-type": "application/json" }
      : konto.headers,
    body: body && JSON.stringify(body),
  });
}

const kindBody = (extra: Record<string, unknown> = {}) => ({
  vorname: "Neues",
  nachname: "Kind",
  stufeId: welt.stufeAId,
  ...extra,
});

async function legeKindAn(konto = admin, extra: Record<string, unknown> = {}) {
  const antwort = await anfrage(konto, "POST", BASIS, kindBody(extra));
  expect(antwort.status).toBe(201);
  return ((await antwort.json()) as { id: string }).id;
}

const aendere = (id: string, body: Record<string, unknown>, konto = admin) =>
  anfrage(konto, "PATCH", `${BASIS}/${id}`, body);

const kindZeile = async (id: string) =>
  (await db.select().from(schema.kind).where(eq(schema.kind.id, id)))[0];
const links = (kindId: string) =>
  db
    .select()
    .from(schema.kindEltern)
    .where(eq(schema.kindEltern.kindId, kindId))
    .orderBy(asc(schema.kindEltern.userId));
const elternIds = async (kindId: string) =>
  (await links(kindId)).map((l) => l.userId).sort();
const auditFuer = (zielId: string) =>
  db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.zielId, zielId),
        eq(schema.auditLog.aktion, "rolle_geaendert"),
      ),
    )
    .orderBy(asc(schema.auditLog.erstelltAm));

async function neuerElternteil(persona: Persona = "elternA") {
  const konto = await legePersonaAn(welt, persona);
  return { ...konto, id: konto.id! };
}

const VOR_EINEM_JAHR = new Date(Date.now() - 365 * 86_400_000);

describe("POST /api/v1/admin/kinder", () => {
  test("legt das Kind in der Abteilung des Admins an, getrimmt, aktiv, ohne Eltern", async () => {
    const id = await legeKindAn(admin, {
      vorname: "  Lena ",
      nachname: " Beispiel  ",
      stufeId: welt.stufeBId,
    });
    expect(await kindZeile(id)).toMatchObject({
      abteilungId: welt.testabteilungId,
      vorname: "Lena",
      nachname: "Beispiel",
      stufeId: welt.stufeBId,
      inaktivSeit: null,
    });
    expect(await links(id)).toEqual([]);
  });

  test("der Demo-Admin legt in der Demo-Abteilung an; die Stufe der Testabteilung gibt 400", async () => {
    const demoAdmin = await legePersonaAn(welt, "demoAdmin");
    const id = await legeKindAn(demoAdmin, { stufeId: welt.demoStufeId });
    expect((await kindZeile(id)).abteilungId).toBe(welt.demoAbteilungId);
    expect((await anfrage(demoAdmin, "POST", BASIS, kindBody())).status).toBe(
      400,
    );
  });

  test("ein Admin der Testabteilung mit der Demo-Stufe gibt 400 und schreibt nichts", async () => {
    const nachname = `Fremd ${randomUUID()}`;
    const antwort = await anfrage(
      admin,
      "POST",
      BASIS,
      kindBody({ stufeId: welt.demoStufeId, nachname }),
    );
    expect(antwort.status).toBe(400);
    expect(
      await db
        .select({ id: schema.kind.id })
        .from(schema.kind)
        .where(eq(schema.kind.nachname, nachname)),
    ).toEqual([]);
  });

  test.each([
    ["unbekannte Stufe", () => ({ stufeId: randomUUID() })],
    ["Stufe keine UUID", () => ({ stufeId: "A" })],
    ["leerer Vorname", () => ({ vorname: "  " })],
    ["leerer Nachname", () => ({ nachname: "" })],
    ["Vorname mit 101 Zeichen", () => ({ vorname: "a".repeat(101) })],
    ["abteilungId im Body", () => ({ abteilungId: welt.demoAbteilungId })],
    ["Eltern im Body", () => ({ eltern: [] })],
  ])("%s gibt 400", async (_titel, extra) => {
    expect(
      (await anfrage(admin, "POST", BASIS, kindBody(extra()))).status,
    ).toBe(400);
  });

  test.each(["slA", "leitendeA", "elternA"] as Persona[])(
    "%s gibt 403",
    async (persona) => {
      const konto = await legePersonaAn(welt, persona);
      expect((await anfrage(konto, "POST", BASIS, kindBody())).status).toBe(
        403,
      );
    },
  );
});

describe("GET /api/v1/admin/kinder", () => {
  type Eintrag = {
    id: string;
    vorname: string;
    nachname: string;
    stufeId: string;
    aktiv: boolean;
    eltern: string[];
  };

  test("liefert Kinder der eigenen Abteilung, auch inaktive, sortiert, nur mit diesen Schlüsseln", async () => {
    const eltern = await neuerElternteil();
    const aktiv = await legeKindAn(admin, { nachname: "Aaa", vorname: "Zoe" });
    const inaktiv = await legeKindAn(admin, {
      nachname: "Aaa",
      vorname: "Amy",
    });
    await aendere(aktiv, { eltern: [eltern.id] });
    await aendere(inaktiv, { aktiv: false });
    const antwort = await anfrage(admin, "GET", BASIS);
    expect(antwort.status).toBe(200);
    const { kinder } = (await antwort.json()) as { kinder: Eintrag[] };
    const eintrag = (id: string) => kinder.find((k) => k.id === id)!;
    expect(Object.keys(eintrag(aktiv)).sort()).toEqual([
      "aktiv",
      "eltern",
      "id",
      "nachname",
      "stufeId",
      "vorname",
    ]);
    expect(eintrag(aktiv)).toEqual({
      id: aktiv,
      vorname: "Zoe",
      nachname: "Aaa",
      stufeId: welt.stufeAId,
      aktiv: true,
      eltern: [eltern.id],
    });
    expect(eintrag(inaktiv)).toMatchObject({ aktiv: false, eltern: [] });
    expect(kinder.map((k) => k.id)).not.toContain(welt.demoKindId);
    const namen = kinder.map((k) => `${k.nachname} ${k.vorname}`);
    expect(namen).toEqual([...namen].sort((a, b) => a.localeCompare(b, "en")));
    expect(namen.indexOf("Aaa Amy")).toBe(namen.indexOf("Aaa Zoe") - 1);
  });

  test("Eltern aus einer anderen Abteilung erscheinen nicht", async () => {
    const kind = await legeKindAn();
    const demoEltern = await neuerElternteil("demoEltern");
    // Wie ein Altbestand: Die Routen verknüpfen nie über Abteilungen
    await db
      .insert(schema.kindEltern)
      .values({ kindId: kind, userId: demoEltern.id });
    const { kinder } = (await (await anfrage(admin, "GET", BASIS)).json()) as {
      kinder: Eintrag[];
    };
    expect(kinder.find((k) => k.id === kind)!.eltern).toEqual([]);
  });

  test("der Demo-Admin sieht nur das Demo-Kind", async () => {
    const demoAdmin = await legePersonaAn(welt, "demoAdmin");
    const { kinder } = (await (
      await anfrage(demoAdmin, "GET", BASIS)
    ).json()) as { kinder: Eintrag[] };
    expect(kinder.map((k) => k.id)).toContain(welt.demoKindId);
    expect(kinder.map((k) => k.id)).not.toContain(welt.kindAId);
  });

  test.each(["slA", "elternA"] as Persona[])("%s gibt 403", async (persona) => {
    const konto = await legePersonaAn(welt, persona);
    expect((await anfrage(konto, "GET", BASIS)).status).toBe(403);
  });
});

describe("PATCH /api/v1/admin/kinder/:id", () => {
  test("ändert die Namen, getrimmt; alles andere bleibt", async () => {
    const id = await legeKindAn();
    const vorher = await kindZeile(id);
    expect(
      (await aendere(id, { vorname: " Mia ", nachname: " Neu " })).status,
    ).toBe(204);
    expect(await kindZeile(id)).toEqual({
      ...vorher,
      vorname: "Mia",
      nachname: "Neu",
    });
  });

  test("ein leerer Body ist ein No-op mit 204", async () => {
    const id = await legeKindAn();
    const vorher = await kindZeile(id);
    expect((await aendere(id, {})).status).toBe(204);
    expect(await kindZeile(id)).toEqual(vorher);
  });

  describe("Stufenwechsel", () => {
    test("eine andere Stufe setzt stufe_seit auf jetzt", async () => {
      const id = await legeKindAn();
      await db
        .update(schema.kind)
        .set({ stufeSeit: VOR_EINEM_JAHR })
        .where(eq(schema.kind.id, id));
      const vorher = Date.now();
      expect((await aendere(id, { stufeId: welt.stufeBId })).status).toBe(204);
      const zeile = await kindZeile(id);
      expect(zeile.stufeId).toBe(welt.stufeBId);
      expect(zeile.stufeSeit.getTime()).toBeGreaterThanOrEqual(vorher - 5000);
    });

    test("dieselbe Stufe lässt stufe_seit unberührt", async () => {
      const id = await legeKindAn();
      await db
        .update(schema.kind)
        .set({ stufeSeit: VOR_EINEM_JAHR })
        .where(eq(schema.kind.id, id));
      expect(
        (await aendere(id, { stufeId: welt.stufeAId, vorname: "Gleich" }))
          .status,
      ).toBe(204);
      expect((await kindZeile(id)).stufeSeit).toEqual(VOR_EINEM_JAHR);
    });

    test.each([
      ["Stufe einer anderen Abteilung", () => welt.demoStufeId],
      ["unbekannte Stufe", () => randomUUID()],
    ])("%s gibt 400 und ändert nichts", async (_titel, stufeId) => {
      const id = await legeKindAn();
      const vorher = await kindZeile(id);
      expect(
        (await aendere(id, { stufeId: stufeId(), vorname: "Nie" })).status,
      ).toBe(400);
      expect(await kindZeile(id)).toEqual(vorher);
    });
  });

  describe("aktiv", () => {
    test("false setzt inaktiv_seit einmal, ein zweites false behält das erste Datum, true löscht es; stufe_seit bleibt", async () => {
      const id = await legeKindAn();
      await db
        .update(schema.kind)
        .set({ stufeSeit: VOR_EINEM_JAHR })
        .where(eq(schema.kind.id, id));
      await aendere(id, { aktiv: false });
      const erstes = (await kindZeile(id)).inaktivSeit;
      expect(erstes).not.toBeNull();
      await aendere(id, { aktiv: false });
      expect((await kindZeile(id)).inaktivSeit).toEqual(erstes);
      await aendere(id, { aktiv: true });
      const aktiv = await kindZeile(id);
      expect(aktiv.inaktivSeit).toBeNull();
      expect(aktiv.stufeSeit).toEqual(VOR_EINEM_JAHR);
    });

    test("true bei einem aktiven Kind ändert nichts", async () => {
      const id = await legeKindAn();
      const vorher = await kindZeile(id);
      expect((await aendere(id, { aktiv: true })).status).toBe(204);
      expect(await kindZeile(id)).toEqual(vorher);
    });
  });

  describe("eltern", () => {
    test("ersetzt die Liste als Differenz: Unveränderte Verknüpfungen behalten erstellt_am", async () => {
      const [a, b, c] = [
        await neuerElternteil(),
        await neuerElternteil(),
        await neuerElternteil(),
      ];
      const id = await legeKindAn();
      await aendere(id, { eltern: [a.id, b.id] });
      await db
        .update(schema.kindEltern)
        .set({ erstelltAm: VOR_EINEM_JAHR })
        .where(eq(schema.kindEltern.kindId, id));
      expect((await aendere(id, { eltern: [b.id, c.id] })).status).toBe(204);
      expect(await elternIds(id)).toEqual([b.id, c.id].sort());
      const bleibt = (await links(id)).find((l) => l.userId === b.id)!;
      expect(bleibt.erstelltAm).toEqual(VOR_EINEM_JAHR);
      const neu = (await links(id)).find((l) => l.userId === c.id)!;
      expect(neu.erstelltAm.getTime()).toBeGreaterThan(
        VOR_EINEM_JAHR.getTime(),
      );
    });

    test("die gleiche Liste noch einmal ist ein No-op ohne Audit-Eintrag", async () => {
      const a = await neuerElternteil();
      const id = await legeKindAn();
      await aendere(id, { eltern: [a.id] });
      const vorher = await links(id);
      expect((await aendere(id, { eltern: [a.id] })).status).toBe(204);
      expect(await links(id)).toEqual(vorher);
      expect(await auditFuer(a.id)).toHaveLength(1);
    });

    test("eine leere Liste löst alle Verknüpfungen", async () => {
      const a = await neuerElternteil();
      const id = await legeKindAn();
      await aendere(id, { eltern: [a.id] });
      expect((await aendere(id, { eltern: [] })).status).toBe(204);
      expect(await links(id)).toEqual([]);
    });

    test.each([
      ["ein unbekannter Elternteil", () => randomUUID()],
      ["ein Elternteil einer anderen Abteilung", () => demoElternId],
    ])("%s gibt 400, nichts wird geschrieben", async (_titel, fremd) => {
      const a = await neuerElternteil();
      const id = await legeKindAn();
      await aendere(id, { eltern: [a.id] });
      const audit = await auditFuer(a.id);
      expect(
        (await aendere(id, { eltern: [fremd()], vorname: "Nie" })).status,
      ).toBe(400);
      expect(await elternIds(id)).toEqual([a.id]);
      expect((await kindZeile(id)).vorname).toBe("Neues");
      expect(await auditFuer(a.id)).toEqual(audit);
    });

    test("ein doppelter Elternteil und mehr als 10 geben 400", async () => {
      const a = await neuerElternteil();
      const id = await legeKindAn();
      expect((await aendere(id, { eltern: [a.id, a.id] })).status).toBe(400);
      expect(
        (await aendere(id, { eltern: Array.from({ length: 11 }, randomUUID) }))
          .status,
      ).toBe(400);
    });

    test("schreibt je betroffenem Elternteil einen Eintrag rolle_geaendert mit dessen neuer Kinderliste, ohne Namen", async () => {
      const a = await neuerElternteil("leitendeAElternB");
      const b = await neuerElternteil();
      const id = await legeKindAn();
      await aendere(id, { eltern: [a.id, b.id] });
      const eintraege = await auditFuer(a.id);
      expect(eintraege).toHaveLength(1);
      expect(eintraege[0]).toMatchObject({
        abteilungId: welt.testabteilungId,
        akteurId: admin.id,
        aktion: "rolle_geaendert",
        zielTyp: "person",
        zielId: a.id,
        // Der Account trägt schon das Kind B der Welt
        details: { elternteilVon: [welt.kindBId, id].sort() },
      });
      await aendere(id, { eltern: [b.id] });
      const danach = await auditFuer(a.id);
      expect(danach).toHaveLength(2);
      expect(danach[1].details).toEqual({ elternteilVon: [welt.kindBId] });
      // b bleibt verknüpft: kein zweiter Eintrag
      expect(await auditFuer(b.id)).toHaveLength(1);
      expect(JSON.stringify(danach)).not.toContain("Neues");
    });
  });

  describe("sofort", () => {
    const gesehen = async (konto: PersonaKonto, kindId: string) => {
      const antwort = await anfrage(konto, "GET", "/api/v1/ich");
      const { kinder } = (await antwort.json()) as { kinder: { id: string }[] };
      return kinder.some((k) => k.id === kindId);
    };

    test("das Verknüpfen und Lösen gilt mit derselben Sitzung ohne Wartezeit", async () => {
      const konto = await neuerElternteil();
      const id = await legeKindAn();
      expect(await gesehen(konto, id)).toBe(false);
      await aendere(id, { eltern: [konto.id] });
      expect(await gesehen(konto, id)).toBe(true);
      await aendere(id, { eltern: [] });
      expect(await gesehen(konto, id)).toBe(false);
    });

    test("ein inaktives Kind verschwindet sofort aus GET /ich, ein reaktiviertes kommt zurück", async () => {
      const konto = await neuerElternteil();
      const id = await legeKindAn();
      await aendere(id, { eltern: [konto.id] });
      expect(await gesehen(konto, id)).toBe(true);
      await aendere(id, { aktiv: false });
      expect(await gesehen(konto, id)).toBe(false);
      await aendere(id, { aktiv: true });
      expect(await gesehen(konto, id)).toBe(true);
    });

    test("das Löschen des Kindes gilt sofort", async () => {
      const konto = await neuerElternteil();
      const id = await legeKindAn();
      await aendere(id, { eltern: [konto.id] });
      expect(await gesehen(konto, id)).toBe(true);
      await anfrage(admin, "DELETE", `${BASIS}/${id}`);
      expect(await gesehen(konto, id)).toBe(false);
    });
  });

  test.each([
    ["unbekanntes Kind", () => randomUUID()],
    ["Kind einer anderen Abteilung", () => welt.demoKindId],
  ])("%s gibt 404", async (_titel, id) => {
    const antwort = await aendere(id(), { vorname: "Nie" });
    expect(antwort.status).toBe(404);
  });

  test("der Demo-Admin ändert kein Kind der Testabteilung (404) und umgekehrt", async () => {
    const demoAdmin = await legePersonaAn(welt, "demoAdmin");
    const id = await legeKindAn();
    expect((await aendere(id, { vorname: "Fremd" }, demoAdmin)).status).toBe(
      404,
    );
    expect((await aendere(welt.demoKindId, { vorname: "Fremd" })).status).toBe(
      404,
    );
    expect((await kindZeile(id)).vorname).toBe("Neues");
  });

  test("keine Admin: 403 ohne Änderung", async () => {
    const sl = await legePersonaAn(welt, "slA");
    const id = await legeKindAn();
    expect((await aendere(id, { vorname: "Nie" }, sl)).status).toBe(403);
    expect((await kindZeile(id)).vorname).toBe("Neues");
  });

  test("eine ID, die keine UUID ist, und ein überzähliger Schlüssel geben 400", async () => {
    const id = await legeKindAn();
    expect((await aendere("nein", { vorname: "X" })).status).toBe(400);
    expect(
      (await aendere(id, { abteilungId: welt.demoAbteilungId })).status,
    ).toBe(400);
  });
});

describe("DELETE /api/v1/admin/kinder/:id", () => {
  test("löscht das Kind und seine Verknüpfungen und protokolliert jeden Elternteil mit dessen Restliste", async () => {
    const [a, b] = [await neuerElternteil(), await neuerElternteil()];
    const id = await legeKindAn();
    const bleibt = await legeKindAn();
    await aendere(id, { eltern: [a.id, b.id] });
    await aendere(bleibt, { eltern: [b.id] });
    expect((await anfrage(admin, "DELETE", `${BASIS}/${id}`)).status).toBe(204);
    expect(await kindZeile(id)).toBeUndefined();
    expect(await links(id)).toEqual([]);
    expect(await kindZeile(bleibt)).toBeDefined();
    const letzterA = (await auditFuer(a.id)).at(-1)!;
    expect(letzterA.details).toEqual({
      elternteilVon: [welt.kindAId].sort(),
    });
    expect((await auditFuer(b.id)).at(-1)!.details).toEqual({
      elternteilVon: [welt.kindAId, bleibt].sort(),
    });
  });

  test("ein Kind ohne Eltern löschen schreibt keinen Eintrag", async () => {
    const id = await legeKindAn();
    expect((await anfrage(admin, "DELETE", `${BASIS}/${id}`)).status).toBe(204);
    expect(
      await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.zielId, id)),
    ).toHaveLength(0);
  });

  test("unbekannt oder fremd 404, kein Admin 403; das Kind bleibt", async () => {
    const sl = await legePersonaAn(welt, "slA");
    const demoAdmin = await legePersonaAn(welt, "demoAdmin");
    const id = await legeKindAn();
    expect(
      (await anfrage(admin, "DELETE", `${BASIS}/${randomUUID()}`)).status,
    ).toBe(404);
    expect((await anfrage(demoAdmin, "DELETE", `${BASIS}/${id}`)).status).toBe(
      404,
    );
    expect((await anfrage(sl, "DELETE", `${BASIS}/${id}`)).status).toBe(403);
    expect(await kindZeile(id)).toBeDefined();
  });
});
