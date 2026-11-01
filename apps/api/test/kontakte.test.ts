import { randomUUID } from "node:crypto";
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

const ROLLEN = [
  "admin",
  "slA",
  "slB",
  "leitendeA",
  "leitendeB",
  "leitendeAElternB",
  "elternA",
  "elternB",
] as const;
type Rolle = (typeof ROLLEN)[number];

const NUMMER_A = "+41 79 111 22 33";
const NUMMER_B = "+41 79 444 55 66";

const setzeNummer = (konto: PersonaKonto, telefon: string | null) =>
  db
    .update(schema.user)
    .set({ telefon })
    .where(eq(schema.user.id, konto.id as string));

let welt: Welt;
let konten: Record<Rolle, PersonaKonto>;

beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
  konten = Object.fromEntries(
    await Promise.all(
      ROLLEN.map(async (p) => [p, await legePersonaAn(welt, p)]),
    ),
  ) as Record<Rolle, PersonaKonto>;
  await setzeNummer(konten.slA, NUMMER_A);
  await setzeNummer(konten.slB, NUMMER_B);
  // Andere Tests legen weitere SL ohne Priorität an; diese beiden sind je Stufe der Hauptkontakt
  await db
    .update(schema.rolle)
    .set({ prioritaet: 1 })
    .where(eq(schema.rolle.userId, idVon("slA")));
  await db
    .update(schema.rolle)
    .set({ prioritaet: 1 })
    .where(eq(schema.rolle.userId, idVon("slB")));
});

// Die Konten dieser Datei haben alle eine ID
const idVon = (rolle: Rolle) => konten[rolle].id as string;

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

// Beginn in einem Jahr: Die Anmeldung der Leitung schliesst mit dem Beginn
const frisch = (stufen: string[]) =>
  legeProgrammAn(db, {
    abteilungId: welt.testabteilungId,
    sichtbarkeit: "eltern",
    stufen,
    beginn: new Date(Date.now() + 365 * 86_400_000),
  });

const anmelden = (
  programmId: string,
  konto: PersonaKonto,
  status: "ja" | "nein",
) =>
  db
    .insert(schema.leitungAnmeldung)
    .values({ programmId, userId: konto.id as string, status })
    .onConflictDoUpdate({
      target: [
        schema.leitungAnmeldung.programmId,
        schema.leitungAnmeldung.userId,
      ],
      set: { status },
    });

type Kontakt = { id: string; name: string; telefon: string | null };

const lies = async (pfad: string, konto: PersonaKonto) => {
  const res = await app.request(pfad, { headers: konto.headers });
  const text = await res.text();
  return {
    status: res.status,
    cacheControl: res.headers.get("cache-control"),
    text,
    kontakte: (res.status === 200
      ? JSON.parse(text).kontakte
      : []) as Kontakt[],
  };
};
const programmKontakte = (id: string, konto: PersonaKonto) =>
  lies(`/api/v1/programme/${id}/kontakte`, konto);
const stufeKontakte = (id: string, konto: PersonaKonto) =>
  lies(`/api/v1/stufen/${id}/kontakte`, konto);

// Name der SL zur Nummer, die die Person sieht
const nummernNachName = (kontakte: Kontakt[]) =>
  Object.fromEntries(kontakte.map((k) => [k.name, k.telefon]));

// Frische Stufe mit SL; prioritaeten[i] ist die Priorität der i-ten SL (null = nicht eingereiht), namen[i] ihr Name, sonst «SL <Priorität>»
const frischeStufe = async (
  prioritaeten: (number | null)[],
  namen: string[] = [],
) => {
  const [stufe] = await db
    .insert(schema.stufe)
    .values({
      abteilungId: welt.testabteilungId,
      name: `Stufe ${randomUUID()}`,
      kuerzel: "F",
    })
    .returning();
  const sl: PersonaKonto[] = [];
  for (const [i, prioritaet] of prioritaeten.entries()) {
    const konto = await legePersonaAn(welt, "slA");
    const userId = konto.id as string;
    await db.delete(schema.rolle).where(eq(schema.rolle.userId, userId));
    await db
      .insert(schema.rolle)
      .values({ userId, stufeId: stufe.id, typ: "stufenleitung", prioritaet });
    await db
      .update(schema.user)
      .set({ name: namen[i] ?? `SL ${prioritaet}` })
      .where(eq(schema.user.id, userId));
    sl.push(konto);
  }
  return { stufeId: stufe.id, sl };
};

// IDs der Kontakte, wie sie der Admin sieht, in Antwortreihenfolge
const ids = async (programmId: string) =>
  (await programmKontakte(programmId, konten.admin)).kontakte.map((k) => k.id);

describe("GET /api/v1/programme/:id/kontakte", () => {
  test("ohne zugeordnete Stufe: leere Liste, 200", async () => {
    const p = await frisch([]);
    const r = await programmKontakte(p.id, konten.admin);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ kontakte: [] });
  });

  test("ein Kontakt je Stufe: die erste SL nach Priorität; «offen» zählt als Zusage", async () => {
    const { stufeId, sl } = await frischeStufe([2, 1, 3]);
    const p = await frisch([stufeId]);
    const r = await programmKontakte(p.id, konten.admin);
    expect(r.kontakte).toEqual([
      {
        id: sl[1].id,
        name: "SL 1",
        bildUrl: null,
        telefon: null,
      },
    ]);
    // Mit Status «ja» bleibt sie vorn
    await anmelden(p.id, sl[1], "ja");
    expect(await ids(p.id)).toEqual([sl[1].id]);
  });

  test("Absage lässt die nächste SL nachrücken; Leitende sind nie Kontakt", async () => {
    const { stufeId, sl } = await frischeStufe([1, 2, 3]);
    const p = await frisch([stufeId]);
    await anmelden(p.id, konten.leitendeA, "ja");
    expect(await ids(p.id)).toEqual([sl[0].id]);
    await anmelden(p.id, sl[0], "nein");
    expect(await ids(p.id)).toEqual([sl[1].id]);
    await anmelden(p.id, sl[1], "nein");
    expect(await ids(p.id)).toEqual([sl[2].id]);
    // Wer wieder zusagt, ist wieder vorn
    await anmelden(p.id, sl[0], "ja");
    expect(await ids(p.id)).toEqual([sl[0].id]);
  });

  test("haben alle abgesagt, bleibt der Hauptkontakt", async () => {
    const { stufeId, sl } = await frischeStufe([1, 2, 3]);
    const p = await frisch([stufeId]);
    for (const s of sl) await anmelden(p.id, s, "nein");
    expect(await ids(p.id)).toEqual([sl[0].id]);
  });

  test("ohne Priorität: eingereihte zuerst, dann nach Name, dann ID", async () => {
    const { stufeId, sl } = await frischeStufe(
      [null, null, 5],
      ["Zora", "Anna", "Zeno"],
    );
    const p = await frisch([stufeId]);
    expect(await ids(p.id)).toEqual([sl[2].id]);
    await anmelden(p.id, sl[2], "nein");
    expect(await ids(p.id)).toEqual([sl[1].id]);
    await anmelden(p.id, sl[1], "nein");
    expect(await ids(p.id)).toEqual([sl[0].id]);

    // Gleicher Name: die kleinere ID gewinnt
    const gleich = await frischeStufe([null, null], ["Gleich", "Gleich"]);
    const q = await frisch([gleich.stufeId]);
    const kleinere = gleich.sl.map((k) => k.id as string).sort()[0];
    expect(await ids(q.id)).toEqual([kleinere]);
  });

  test("Stufe ohne SL: leere Liste, auch wenn alle zugeordneten Stufen keine haben", async () => {
    const { stufeId } = await frischeStufe([]);
    const p = await frisch([stufeId]);
    const r = await programmKontakte(p.id, konten.admin);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ kontakte: [] });
  });

  test("zwei Stufen: ein Kontakt je Stufe, dieselbe SL nur einmal", async () => {
    const a = await frischeStufe([1, 2]);
    const b = await frischeStufe([1, 2]);
    const p = await frisch([a.stufeId, b.stufeId]);
    expect((await ids(p.id)).sort()).toEqual([a.sl[0].id, b.sl[0].id].sort());
    // Stufe A: Erste sagt ab, Zweite rückt nach; Stufe B bleibt
    await anmelden(p.id, a.sl[0], "nein");
    expect((await ids(p.id)).sort()).toEqual([a.sl[1].id, b.sl[0].id].sort());

    // Dieselbe Person in beiden Stufen an erster Stelle: einmal
    const doppelt = await legePersonaAn(welt, "slA");
    for (const stufeId of [a.stufeId, b.stufeId]) {
      await db
        .insert(schema.rolle)
        .values({
          userId: doppelt.id as string,
          stufeId,
          typ: "stufenleitung",
          prioritaet: 1,
        })
        .onConflictDoNothing();
    }
    await db
      .update(schema.rolle)
      .set({ prioritaet: 1 })
      .where(eq(schema.rolle.userId, doppelt.id as string));
    expect(await ids(p.id)).toContain(doppelt.id);
    expect((await ids(p.id)).filter((id) => id === doppelt.id)).toHaveLength(1);
  });

  test("Eltern der Stufe sehen die Nummer, alle anderen nie, auch Admins nicht", async () => {
    const p = await frisch([welt.stufeAId, welt.stufeBId]);
    await anmelden(p.id, konten.slA, "ja");
    await anmelden(p.id, konten.slB, "ja");
    const sicht = async (rolle: Rolle) => {
      const r = await programmKontakte(p.id, konten[rolle]);
      expect(r.status).toBe(200);
      expect(r.cacheControl).toBe("no-store");
      // Andere Tests legen weitere SL in den Stufen an; hier zählen nur diese beiden
      const eigene = [idVon("slA"), idVon("slB")];
      return {
        ...r,
        kontakte: r.kontakte.filter((k) => eigene.includes(k.id)),
      };
    };
    // Die Namen sehen alle, die das Programm sehen; die Nummer Eltern mit aktivem Kind sowie Leitung und SL in der Stufe der SL
    const a = await sicht("elternA");
    const b = await sicht("elternB");
    // Leitende A und zugleich Elternteil B: beide Nummern
    const gemischt = await sicht("leitendeAElternB");
    expect(a.kontakte.map((k) => k.name)).toEqual(["SL A", "SL B"]);
    expect(nummernNachName(a.kontakte)).toEqual({
      "SL A": NUMMER_A,
      "SL B": null,
    });
    expect(nummernNachName(b.kontakte)).toEqual({
      "SL A": null,
      "SL B": NUMMER_B,
    });
    expect(nummernNachName(gemischt.kontakte)).toEqual({
      "SL A": NUMMER_A,
      "SL B": NUMMER_B,
    });
    for (const [rolle, erwartet] of [
      ["slA", { "SL A": NUMMER_A, "SL B": null }],
      ["leitendeA", { "SL A": NUMMER_A, "SL B": null }],
      ["slB", { "SL A": null, "SL B": NUMMER_B }],
      ["leitendeB", { "SL A": null, "SL B": NUMMER_B }],
      // Admin ohne Rolle in den Stufen: Namen, keine Nummer
      ["admin", { "SL A": null, "SL B": null }],
    ] as const) {
      expect(nummernNachName((await sicht(rolle)).kontakte)).toEqual(erwartet);
    }
  });

  test("Eltern einer anderen Stufe sehen das Programm nicht: 404 ohne Nummer", async () => {
    const p = await frisch([welt.stufeAId]);
    await anmelden(p.id, konten.slA, "ja");
    const r = await programmKontakte(p.id, konten.elternB);
    expect(r.status).toBe(404);
    expect(r.text).not.toContain("79 111");
  });

  test("eine abgemeldete SL verschwindet sofort", async () => {
    const p = await frisch([welt.stufeAId]);
    await anmelden(p.id, konten.slA, "ja");
    const ids = async () =>
      (await programmKontakte(p.id, konten.elternA)).kontakte.map((k) => k.id);
    expect(await ids()).toContain(idVon("slA"));

    const res = await app.request(`/api/v1/programme/${p.id}/leitung`, {
      method: "PUT",
      headers: { ...konten.slA.headers, "content-type": "application/json" },
      body: JSON.stringify({ status: "nein" }),
    });
    expect(res.status).toBe(204);
    const danach = await programmKontakte(p.id, konten.elternA);
    expect(danach.status).toBe(200);
    expect(await ids()).not.toContain(idVon("slA"));
  });

  test("eine deaktivierte SL und eine ohne Rolle zählen nicht", async () => {
    const { stufeId, sl } = await frischeStufe([1, 2]);
    const p = await frisch([stufeId]);
    expect(await ids(p.id)).toEqual([sl[0].id]);

    await db
      .update(schema.user)
      .set({ deaktiviertAm: new Date() })
      .where(eq(schema.user.id, sl[0].id as string));
    expect(await ids(p.id)).toEqual([sl[1].id]);

    await db
      .update(schema.user)
      .set({ deaktiviertAm: null })
      .where(eq(schema.user.id, sl[0].id as string));
    expect(await ids(p.id)).toEqual([sl[0].id]);
    await db
      .delete(schema.rolle)
      .where(eq(schema.rolle.userId, sl[0].id as string));
    expect(await ids(p.id)).toEqual([sl[1].id]);
  });

  test("Eltern mit nur noch inaktivem Kind verlieren Programm und Nummer", async () => {
    const p = await frisch([welt.stufeAId]);
    await anmelden(p.id, konten.slA, "ja");
    const eltern = await legePersonaAn(welt, "elternA");
    expect((await programmKontakte(p.id, eltern)).status).toBe(200);
    await db
      .update(schema.kind)
      .set({ inaktivSeit: new Date() })
      .where(eq(schema.kind.id, welt.kindAId));
    try {
      const r = await programmKontakte(p.id, eltern);
      expect(r.status).toBe(404);
      expect(r.text).not.toContain("79 111");
    } finally {
      await db
        .update(schema.kind)
        .set({ inaktivSeit: null })
        .where(eq(schema.kind.id, welt.kindAId));
    }
  });

  test("unbekannte Programme sind 404, eine ungültige ID 400", async () => {
    const unbekannt = "00000000-0000-4000-8000-000000000000";
    expect((await programmKontakte(unbekannt, konten.admin)).status).toBe(404);
    expect((await programmKontakte("keine-uuid", konten.admin)).status).toBe(
      400,
    );
  });
});

describe("GET /api/v1/stufen/:id/kontakte", () => {
  test("liefert die aktiven SL der Stufe; die Nummer den Eltern, der Leitung und der SL der Stufe", async () => {
    // Weitere SL der Stufe aus anderen Tests tragen keine Nummer; ohne Rolle oder deaktiviert fehlen sie
    const ohneNummer = await legePersonaAn(welt, "slA");
    const eltern = await stufeKontakte(welt.stufeAId, konten.elternA);
    expect(eltern.status).toBe(200);
    expect(eltern.cacheControl).toBe("no-store");
    expect(eltern.kontakte).toEqual(
      expect.arrayContaining([
        {
          id: idVon("slA"),
          name: "SL A",
          bildUrl: null,
          telefon: NUMMER_A,
        },
        {
          id: ohneNummer.id,
          name: "SL A",
          bildUrl: null,
          telefon: null,
        },
      ]),
    );
    expect(eltern.kontakte.map((k) => k.id)).not.toContain(idVon("slB"));

    // Leitung und SL der Stufe sehen die Nummer wie die Eltern
    for (const rolle of ["leitendeA", "slA", "leitendeAElternB"] as const) {
      const r = await stufeKontakte(welt.stufeAId, konten[rolle]);
      expect(r.status).toBe(200);
      expect(r.cacheControl).toBe("no-store");
      expect(r.kontakte.find((k) => k.id === idVon("slA"))?.telefon).toBe(
        NUMMER_A,
      );
    }
    // Wer die Stufe nur verwaltet, sieht die Namen, aber keine Nummer
    const admin = await stufeKontakte(welt.stufeAId, konten.admin);
    expect(admin.status).toBe(200);
    expect(admin.kontakte.length).toBeGreaterThan(0);
    expect(admin.kontakte.every((k) => k.telefon === null)).toBe(true);
    expect(admin.text).not.toContain("79 111");
  });

  test("eine deaktivierte SL fehlt", async () => {
    const sl = await legePersonaAn(welt, "slA");
    const ids = async () =>
      (await stufeKontakte(welt.stufeAId, konten.elternA)).kontakte.map(
        (k) => k.id,
      );
    expect(await ids()).toContain(sl.id);
    await db
      .update(schema.user)
      .set({ banned: true, deaktiviertAm: new Date() })
      .where(eq(schema.user.id, sl.id as string));
    expect(await ids()).not.toContain(sl.id);
  });

  test("Eltern einer anderen Stufe, Leitende und SL anderer Stufen: 404 ohne Nummer", async () => {
    for (const rolle of ["elternB", "leitendeB", "slB"] as const) {
      const r = await stufeKontakte(welt.stufeAId, konten[rolle]);
      expect(r.status).toBe(404);
      expect(r.text).not.toContain("79 111");
    }
  });

  test("Elternteil mit nur noch inaktivem Kind in der Stufe: 404", async () => {
    const eltern = await legePersonaAn(welt, "elternA");
    await db
      .update(schema.kind)
      .set({ inaktivSeit: new Date() })
      .where(eq(schema.kind.id, welt.kindAId));
    try {
      expect((await stufeKontakte(welt.stufeAId, eltern)).status).toBe(404);
    } finally {
      await db
        .update(schema.kind)
        .set({ inaktivSeit: null })
        .where(eq(schema.kind.id, welt.kindAId));
    }
  });

  test("Stufe einer anderen Abteilung und unbekannte Stufe: 404", async () => {
    const unbekannt = "00000000-0000-4000-8000-000000000000";
    expect((await stufeKontakte(welt.demoStufeId, konten.admin)).status).toBe(
      404,
    );
    expect((await stufeKontakte(unbekannt, konten.admin)).status).toBe(404);
  });
});

describe("PATCH /api/v1/ich: Telefon", () => {
  const patch = (konto: PersonaKonto, body: unknown) =>
    app.request("/api/v1/ich", {
      method: "PATCH",
      headers: { ...konto.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const telefon = async (konto: PersonaKonto) =>
    (
      await (
        await app.request("/api/v1/ich", { headers: konto.headers })
      ).json()
    ).telefon;

  test("SL speichert, ändert und entfernt ihre Nummer", async () => {
    const sl = await legePersonaAn(welt, "slA");
    expect((await patch(sl, { telefon: "  079 123 45 67 " })).status).toBe(204);
    expect(await telefon(sl)).toBe("079 123 45 67");
    expect(
      (await patch(sl, { telefon: "+41 44 123 45 67", pushAnmeldungen: false }))
        .status,
    ).toBe(204);
    expect(await telefon(sl)).toBe("+41 44 123 45 67");
    expect((await patch(sl, { telefon: null })).status).toBe(204);
    expect(await telefon(sl)).toBeNull();
    expect((await patch(sl, { telefon: "079 123 45 67" })).status).toBe(204);
    expect((await patch(sl, { telefon: "" })).status).toBe(204);
    expect(await telefon(sl)).toBeNull();
  });

  test.each(["elternA", "leitendeA", "admin"] as const)(
    "%s darf keine Nummer speichern: 403, nichts geändert",
    async (persona) => {
      const konto = await legePersonaAn(welt, persona);
      expect((await patch(konto, { telefon: "079 123 45 67" })).status).toBe(
        403,
      );
      expect(await telefon(konto)).toBeNull();
    },
  );

  test("wer die Rolle verloren hat, darf die Nummer nicht mehr setzen, aber entfernen", async () => {
    const sl = await legePersonaAn(welt, "slA");
    await setzeNummer(sl, "079 123 45 67");
    await db
      .delete(schema.rolle)
      .where(eq(schema.rolle.userId, sl.id as string));
    expect((await patch(sl, { telefon: "079 765 43 21" })).status).toBe(403);
    expect(await telefon(sl)).toBe("079 123 45 67");
    expect((await patch(sl, { telefon: null })).status).toBe(204);
    expect(await telefon(sl)).toBeNull();
  });

  test.each([
    ["Buchstaben", "079 abc 45 67"],
    ["zu kurz", "123"],
    ["zu lang", "0".repeat(31)],
    ["ein Link", "tel:079 123 45 67"],
    ["eine Zahl", 791234567],
  ])("%s ergibt 400 und ändert nichts", async (_titel, wert) => {
    const sl = await legePersonaAn(welt, "slA");
    expect((await patch(sl, { telefon: wert })).status).toBe(400);
    expect(await telefon(sl)).toBeNull();
  });
});
