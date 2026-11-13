import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";
import { erstelleDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import {
  loescheAlteNachrichten,
  starteNachrichtenAufraeumen,
} from "../src/nachrichten-aufraeumen.js";
import { API_URL } from "./hilfen/datenbank.js";

const sql = postgres(API_URL);
// Eigener Client für Drizzle: drizzle() liefert Zeitpunkte seines Clients danach als Text
const db = erstelleDb(postgres(API_URL));
afterAll(() => Promise.all([sql.end(), db.$client.end()]));

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

const MONAT = 31 * 24 * 60 * 60 * 1000;
const vor = (monate: number) => new Date(Date.now() - monate * MONAT);

test("löscht 6 Monate nach Ablauf, ohne Ablauf 6 Monate nach dem Erstellen; die Lesemarke geht mit", async () => {
  const [person] = await sql`
    insert into "user" (name, email)
    values ('Testperson', ${`${randomUUID()}@example.org`})
    returning id`;
  const neu = async (laeuftAbAm: Date | null, erstelltAm: Date = new Date()) =>
    (
      await db
        .insert(schema.nachricht)
        .values({ titel: "t", text: "x", laeuftAbAm, erstelltAm })
        .returning({ id: schema.nachricht.id })
    )[0].id;
  const alterAblauf = await neu(vor(7), vor(8));
  const juengerAblauf = await neu(vor(5), vor(8));
  const alteOhneAblauf = await neu(null, vor(7));
  const frischeOhneAblauf = await neu(null, vor(1));
  const kuenftig = await neu(new Date(Date.now() + MONAT), vor(8));
  await db
    .insert(schema.nachrichtGelesen)
    .values({ nachrichtId: alterAblauf, userId: person.id });

  // Mindestens: Andere Testdateien laufen parallel auf derselben Datenbank
  expect(await loescheAlteNachrichten(db)).toBeGreaterThanOrEqual(2);

  const alle = [
    alterAblauf,
    juengerAblauf,
    alteOhneAblauf,
    frischeOhneAblauf,
    kuenftig,
  ];
  const uebrig = (
    await db
      .select({ id: schema.nachricht.id })
      .from(schema.nachricht)
      .where(inArray(schema.nachricht.id, alle))
  ).map((z) => z.id);
  expect(uebrig.sort()).toEqual(
    [juengerAblauf, frischeOhneAblauf, kuenftig].sort(),
  );
  expect(
    await db
      .select()
      .from(schema.nachrichtGelesen)
      .where(eq(schema.nachrichtGelesen.nachrichtId, alterAblauf)),
  ).toHaveLength(0);
});

test("das Konto löschen nimmt seine Lesemarken mit, die Mitteilung bleibt", async () => {
  const [person] = await sql`
    insert into "user" (name, email)
    values ('Testperson', ${`${randomUUID()}@example.org`})
    returning id`;
  const [{ id }] = await db
    .insert(schema.nachricht)
    .values({ titel: "t", text: "x" })
    .returning({ id: schema.nachricht.id });
  await db
    .insert(schema.nachrichtGelesen)
    .values({ nachrichtId: id, userId: person.id });
  await sql`delete from "user" where id = ${person.id}`;
  expect(
    await db
      .select()
      .from(schema.nachrichtGelesen)
      .where(eq(schema.nachrichtGelesen.nachrichtId, id)),
  ).toHaveLength(0);
  expect(
    await db.select().from(schema.nachricht).where(eq(schema.nachricht.id, id)),
  ).toHaveLength(1);
});

test("der Lauf läuft sofort und dann alle 24 Stunden, das Log nennt nur Anzahl oder Code", async () => {
  vi.useFakeTimers();
  try {
    const lauf = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(3)
      .mockRejectedValueOnce({ code: "ECONNREFUSED", message: "geheim" });
    const timer = starteNachrichtenAufraeumen(lauf);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    clearInterval(timer);
    expect(lauf).toHaveBeenCalledTimes(2);
    const zeilen = ausgabe.mock.calls.map((a) => JSON.parse(a[0] as string));
    expect(zeilen[0]).toMatchObject({ ereignis: "nachrichten", geloescht: 3 });
    expect(zeilen[1]).toMatchObject({
      ereignis: "nachrichten",
      code: "ECONNREFUSED",
    });
    expect(JSON.stringify(zeilen)).not.toContain("geheim");
  } finally {
    vi.useRealTimers();
  }
});
