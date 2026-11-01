import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, expect, test } from "vitest";
import { API_URL } from "./hilfen/datenbank.js";
import { scheitert, zurueckgerollt } from "./transaktion.js";

const sql = postgres(API_URL);
afterAll(() => sql.end());

test("die API-Rolle ergänzt und liest audit_log, kann Einträge aber weder ändern noch löschen", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const [bezirk] =
      await tx`insert into bezirk (name) values (${`Bezirk ${randomUUID()}`}) returning id`;
    const [eintrag] = await tx`
      insert into audit_log (akteur_id, aktion, ziel_typ, ziel_id)
      values ('cli', 'test', 'bezirk', ${bezirk.id})
      returning id`;

    await scheitert(
      tx,
      { code: "42501" },
      (sp) =>
        sp`update audit_log set aktion = 'geaendert' where id = ${eintrag.id}`,
    );
    await scheitert(
      tx,
      { code: "42501" },
      (sp) => sp`delete from audit_log where id = ${eintrag.id}`,
    );
    await scheitert(tx, { code: "42501" }, (sp) => sp`truncate audit_log`);
    await scheitert(tx, { code: "42501" }, (sp) => sp`drop table audit_log`);
    expect(
      await tx`select aktion from audit_log where id = ${eintrag.id}`,
    ).toEqual([{ aktion: "test" }]);
  });
});

test("die API-Rolle benennt Bezirke um und löscht sie", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const [bezirk] =
      await tx`insert into bezirk (name) values (${`Bezirk ${randomUUID()}`}) returning id`;

    await tx`update bezirk set name = 'Umbenannt' where id = ${bezirk.id}`;
    expect(await tx`select name from bezirk where id = ${bezirk.id}`).toEqual([
      { name: "Umbenannt" },
    ]);
    await tx`delete from bezirk where id = ${bezirk.id}`;
    expect(await tx`select id from bezirk where id = ${bezirk.id}`).toEqual([]);
  });
});

test("die API-Rolle legt keine Tabellen an", async () => {
  await zurueckgerollt(sql, async (tx) => {
    await scheitert(
      tx,
      { code: "42501" },
      (sp) => sp`create table test_tabelle (id int)`,
    );
  });
});

test("die API-Rolle ist kein Superuser und legt weder Datenbanken noch Rollen an", async () => {
  expect(
    await sql`
      select current_user as rolle, rolsuper, rolcreatedb, rolcreaterole
      from pg_roles where rolname = current_user`,
  ).toEqual([
    {
      rolle: "fireresponse_api",
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
    },
  ]);
});

test("alle Tabellen in public gehören fireresponse_besitzer", async () => {
  const tabellen =
    await sql`select tablename, tableowner from pg_tables where schemaname = 'public'`;
  expect(tabellen.map((t) => t.tablename)).toContain("audit_log");
  expect(new Set(tabellen.map((t) => t.tableowner))).toEqual(
    new Set(["fireresponse_besitzer"]),
  );
});
