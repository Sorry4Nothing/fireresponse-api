import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, describe, expect, test, vi } from "vitest";
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { ladeSeiten } from "../src/seiten.js";
import {
  APP,
  bereiteAuthTestsVor,
  erstelleTestAuth,
  zufallsIp,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  type Persona,
  type PersonaKonto,
} from "./hilfen/personas.js";
import { legeProgrammAn } from "./hilfen/programme.js";

bereiteAuthTestsVor();
// Jede Persona und jede Anmeldung rechnet scrypt
vi.setConfig({ hookTimeout: 120_000 });

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

// Eigene Welt pro Test: Die Fälle hängen an der genauen Zahl der Rollen einer Einheit
async function eigeneWelt() {
  const welt = await erstelleWelt(db, auth);
  const persona = (p: Persona) => legePersonaAn(welt, p);
  return { welt, persona };
}

const loesche = (aktor: PersonaKonto, zielId: string) =>
  app.request(`/api/v1/admin/konten/${zielId}`, {
    method: "DELETE",
    headers: aktor.headers,
  });
const suche = (aktor: PersonaKonto, benutzername: string) =>
  app.request(
    `/api/v1/admin/konten?benutzername=${encodeURIComponent(benutzername)}`,
    { headers: aktor.headers },
  );
const meldeAn = (konto: PersonaKonto) =>
  app.request("/api/auth/sign-in/username", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "expo-origin": APP,
      "x-forwarded-for": zufallsIp(),
    },
    body: JSON.stringify({
      username: konto.benutzername,
      password: konto.passwort,
    }),
  });

const userZeile = async (id: string) =>
  (await db.select().from(schema.user).where(eq(schema.user.id, id)))[0];
const auditZeilen = (zielId: string) =>
  db.select().from(schema.auditLog).where(eq(schema.auditLog.zielId, zielId));
const fehlercode = async (antwort: Response) => (await antwort.json()).code;

// Jede Spalte der Datenbank, die Text oder eine UUID trägt, auf einen der Werte; die Liste kommt aus dem Katalog, spätere Tabellen sind also dabei
async function treffer(werte: string[]) {
  const spalten = await sql<{ tabelle: string; spalte: string }[]>`
    select table_name as tabelle, column_name as spalte
    from information_schema.columns
    where table_schema = 'public'
      and data_type in ('uuid', 'text', 'character varying', 'jsonb')`;
  const gefunden: string[] = [];
  for (const { tabelle, spalte } of spalten) {
    for (const wert of werte) {
      const zeilen = await sql`
        select 1 from ${sql(tabelle)}
        where strpos(${sql(spalte)}::text, ${wert}) > 0 limit 1`;
      if (zeilen.length > 0) gefunden.push(`${tabelle}.${spalte}`);
    }
  }
  return gefunden;
}

describe("Konto löschen in der Verwaltung", () => {
  test("nach dem Löschen zeigt keine Zeile mehr auf die Person, ausser dem Audit-Log", async () => {
    const { welt, persona } = await eigeneWelt();
    // Stellvertretung mit zweitem Faktor: Sie hat Faktor, Sitzung, Rolle und alles, was am Konto hängt
    const ziel = await persona("stellvertretung1JfA");
    const admin = await persona("kantonsadmin");
    const id = ziel.id!;
    const programm = await legeProgrammAn(db, { einheitId: welt.einheit.jfA });
    await db
      .insert(schema.leitungAnmeldung)
      .values({ programmId: programm.id, userId: id, status: "ja" });
    await db.insert(schema.teilnahme).values({
      programmId: programm.id,
      teilnehmendeId: welt.teilnehmende.jfA,
      status: "ja",
      geaendertVon: id,
    });
    await db
      .insert(schema.profilbild)
      .values({ userId: id, inhalt: Buffer.from("bild") });
    // Eine Anmeldung bleibt beim Code stehen: Die Zeile «2fa-…» trägt die ID der Person
    expect(await (await meldeAn(ziel)).json()).toMatchObject({
      twoFactorRedirect: true,
    });
    const [sitzung] = await db
      .select()
      .from(schema.session)
      .where(eq(schema.session.userId, id));
    await db.insert(schema.pushToken).values({
      sessionId: sitzung.id,
      userId: id,
      token: randomUUID(),
      plattform: "ios",
    });
    await db.insert(schema.auditLog).values({
      einheitId: welt.einheit.jfA,
      akteurId: admin.id!,
      aktion: "test",
      zielTyp: "konto",
      zielId: randomUUID(),
    });
    const verifikation = await db
      .select()
      .from(schema.verification)
      .where(eq(schema.verification.value, id));
    expect(verifikation.length).toBeGreaterThanOrEqual(1);
    const { email } = await userZeile(id);

    const antwort = await loesche(admin, id);
    expect(antwort.status).toBe(204);
    expect(await antwort.text()).toBe("");

    expect(await userZeile(id)).toBeUndefined();
    // Nur im Audit-Log, und da nur die ID: weder Benutzername noch E-Mail-Adresse stehen irgendwo
    expect(await treffer([id])).toEqual(["audit_log.ziel_id"]);
    expect(await treffer([ziel.benutzername!, email])).toEqual([]);
    expect(await auditZeilen(id)).toEqual([
      expect.objectContaining({
        einheitId: welt.einheit.jfA,
        akteurId: admin.id,
        aktion: "konto_geloescht",
        zielTyp: "konto",
        zielId: id,
        details: null,
      }),
    ]);
    // Programm, Anmeldung der Teilnehmenden und Person bleiben; nur der Verweis auf die Löschende fällt weg
    const [teilnahme] = await db
      .select()
      .from(schema.teilnahme)
      .where(eq(schema.teilnahme.programmId, programm.id));
    expect(teilnahme).toMatchObject({ geaendertVon: null, status: "ja" });

    // Die Sitzung ist ungültig, die Anmeldung gibt den einen Fehler
    expect(
      (await app.request("/api/v1/ich", { headers: ziel.headers })).status,
    ).toBe(401);
    const neu = await meldeAn(ziel);
    expect(neu.status).toBe(401);
    expect(await fehlercode(neu)).toBe("ANMELDUNG_FEHLGESCHLAGEN");
  });

  test("das Kommando löscht Eltern seiner Einheit; die teilnehmende Person und das andere Elternteil bleiben", async () => {
    const { welt, persona } = await eigeneWelt();
    const kommando = await persona("kommandoJfA");
    const eltern = await persona("elternJfA");
    const anderes = await persona("ohneEinwilligung");

    expect((await loesche(kommando, eltern.id!)).status).toBe(204);

    expect(await userZeile(eltern.id!)).toBeUndefined();
    const [kind] = await db
      .select()
      .from(schema.teilnehmende)
      .where(eq(schema.teilnehmende.id, welt.teilnehmende.jfA));
    expect(kind).toBeDefined();
    expect(
      await db
        .select()
        .from(schema.teilnehmendeKonto)
        .where(
          and(
            eq(schema.teilnehmendeKonto.teilnehmendeId, welt.teilnehmende.jfA),
            eq(schema.teilnehmendeKonto.userId, anderes.id!),
          ),
        ),
    ).toHaveLength(1);
    expect(await auditZeilen(eltern.id!)).toEqual([
      expect.objectContaining({
        einheitId: welt.einheit.jfA,
        akteurId: kommando.id,
      }),
    ]);
  });

  test("Kantonsadmin löscht ein Konto in mehreren Einheiten und eines ohne Einheit; das Kommando löscht das erste nicht", async () => {
    const { persona } = await eigeneWelt();
    const kommando = await persona("kommandoJfA");
    const admin = await persona("kantonsadmin");
    const mehrere = await persona("leitendeJfAElternKfA");
    // Leitung in JF A, Eltern in KF A: JF A allein darf das Konto nicht entfernen
    const verweigert = await loesche(kommando, mehrere.id!);
    expect(verweigert.status).toBe(403);
    expect(await userZeile(mehrere.id!)).toBeDefined();

    expect((await loesche(admin, mehrere.id!)).status).toBe(204);
    // Zwei Einheiten: Der Eintrag nennt keine
    expect(await auditZeilen(mehrere.id!)).toEqual([
      expect.objectContaining({ einheitId: null, akteurId: admin.id }),
    ]);

    const [ohne] = await db
      .insert(schema.user)
      .values({
        name: "Ohne Einheit",
        email: `${randomUUID()}@example.org`,
        username: `ohne.${randomUUID().slice(0, 8)}`,
      })
      .returning({ id: schema.user.id });
    expect((await loesche(kommando, ohne.id)).status).toBe(404);
    expect((await loesche(admin, ohne.id)).status).toBe(204);
  });

  test("Stellvertretungen löschen keine Stellvertretung, das Kommando schon; kein Konto des Kantonsadmins", async () => {
    const { persona } = await eigeneWelt();
    const kommando = await persona("kommandoJfA");
    const stv1 = await persona("stellvertretung1JfA");
    const stv2 = await persona("stellvertretung2JfA");
    const leitende = await persona("leitendeJfA");
    const admin = await persona("kantonsadminOhneZweitenFaktor");

    expect((await loesche(stv1, stv2.id!)).status).toBe(403);
    expect(await userZeile(stv2.id!)).toBeDefined();
    // Leitende löscht auch die Stellvertretung nicht, ein Kantonsadmin-Konto ist für das Kommando unsichtbar
    expect((await loesche(kommando, admin.id!)).status).toBe(404);
    expect((await loesche(stv1, leitende.id!)).status).toBe(204);
    expect((await loesche(kommando, stv2.id!)).status).toBe(204);
  });

  test("409: das eigene Konto und die Kommandantin oder der Kommandant bleiben, die Übergabe kommt zuerst", async () => {
    const { welt, persona } = await eigeneWelt();
    const kommando = await persona("kommandoJfA");
    const stv = await persona("stellvertretung1JfA");
    const admin = await persona("kantonsadmin");
    const zweiterAdmin = await persona("kantonsadminOhneZweitenFaktor");

    for (const [aktor, ziel, code] of [
      [kommando, kommando, "EIGENES_KONTO"],
      [admin, admin, "EIGENES_KONTO"],
      [admin, kommando, "KOMMANDANT"],
      [stv, kommando, "KOMMANDANT"],
    ] as const) {
      const antwort = await loesche(aktor, ziel.id!);
      expect(antwort.status, `${code}`).toBe(409);
      expect(await fehlercode(antwort)).toBe(code);
      expect(await userZeile(ziel.id!)).toBeDefined();
    }
    // Nach der Übergabe geht es; ein anderes Admin-Konto löscht der Kantonsadmin ebenfalls
    await db
      .update(schema.einheitRolle)
      .set({ typ: "leitung" })
      .where(
        and(
          eq(schema.einheitRolle.userId, kommando.id!),
          eq(schema.einheitRolle.einheitId, welt.einheit.jfA),
        ),
      );
    expect((await loesche(admin, kommando.id!)).status).toBe(204);
    expect((await loesche(admin, zweiterAdmin.id!)).status).toBe(204);
    expect(await userZeile(admin.id!)).toBeDefined();
  });

  test("unbekannte und ungültige IDs, fremde Einheiten, fehlende Rechte", async () => {
    const { persona } = await eigeneWelt();
    const kommando = await persona("kommandoJfA");
    const fremd = await persona("kommandoKfA");
    const eltern = await persona("elternJfA");
    const andere = await persona("leitendeJfA");

    expect((await loesche(kommando, randomUUID())).status).toBe(404);
    expect((await loesche(kommando, "keine-uuid")).status).toBe(400);
    // Anderer Bezirk und andere Art der Einheit: unsichtbar
    expect((await loesche(fremd, eltern.id!)).status).toBe(404);
    // Sichtbar, aber ohne Recht
    expect((await loesche(andere, eltern.id!)).status).toBe(403);
    expect((await loesche(eltern, andere.id!)).status).toBe(403);
    expect(await userZeile(eltern.id!)).toBeDefined();
    expect(await userZeile(andere.id!)).toBeDefined();
  });

  test("ein Konto mit eigenem Zugang zu einer teilnehmenden Person: Das Konto geht, der Eintrag der Person bleibt", async () => {
    const { welt, persona } = await eigeneWelt();
    const kommando = await persona("kommandoJfA");
    const selbst = await persona("teilnehmendeSelbstJfA");

    expect((await loesche(kommando, selbst.id!)).status).toBe(204);
    expect(
      await db
        .select()
        .from(schema.teilnehmende)
        .where(eq(schema.teilnehmende.id, welt.teilnehmende.jfAWechsel)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.teilnehmendeKonto)
        .where(
          eq(
            schema.teilnehmendeKonto.teilnehmendeId,
            welt.teilnehmende.jfAWechsel,
          ),
        ),
    ).toHaveLength(0);
  });
});

describe("Konto suchen vor dem Löschen", () => {
  test("liefert Name, Benutzername und die sichtbaren Einheiten mit Rolle, sonst nichts", async () => {
    const { welt, persona } = await eigeneWelt();
    const kommando = await persona("kommandoJfA");
    const admin = await persona("kantonsadmin");
    const ziel = await persona("leitendeJfAElternKfA");

    const fuerAdmin = await suche(admin, ziel.benutzername!.toUpperCase());
    expect(fuerAdmin.status).toBe(200);
    const koerper = await fuerAdmin.json();
    expect(Object.keys(koerper).sort()).toEqual([
      "benutzername",
      "einheiten",
      "id",
      "name",
    ]);
    expect(koerper).toMatchObject({
      id: ziel.id,
      benutzername: ziel.benutzername,
    });
    expect(koerper.einheiten).toEqual(
      expect.arrayContaining([
        { einheitId: welt.einheit.jfA, einheitName: "JF A", rolle: "leitung" },
        { einheitId: welt.einheit.kfA, einheitName: "KF A", rolle: "eltern" },
      ]),
    );
    expect(koerper.einheiten).toHaveLength(2);

    // Das Kommando von JF A sieht die Leitung, aber nicht die Verknüpfung zu KF A
    const fuerKommando = await (
      await suche(kommando, ziel.benutzername!)
    ).json();
    expect(fuerKommando.einheiten).toEqual([
      { einheitId: welt.einheit.jfA, einheitName: "JF A", rolle: "leitung" },
    ]);
  });

  test("unbekannt oder ungültig", async () => {
    const { persona } = await eigeneWelt();
    const admin = await persona("kantonsadmin");
    expect((await suche(admin, "gibt.es.nicht")).status).toBe(404);
    expect(
      (await app.request("/api/v1/admin/konten", { headers: admin.headers }))
        .status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/v1/admin/konten?benutzername=a&x=1", {
          headers: admin.headers,
        })
      ).status,
    ).toBe(400);
  });
});
