import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, expect, test } from "vitest";
import { API_URL } from "./hilfen/datenbank.js";
import { scheitert, zurueckgerollt } from "./transaktion.js";

const sql = postgres(API_URL);
afterAll(() => sql.end());

type Tx = postgres.TransactionSql;

async function person(tx: Tx, username?: string) {
  const [zeile] = await tx`
    insert into "user" (name, email, username)
    values ('Testperson', ${`${randomUUID()}@example.org`}, ${username ?? null})
    returning id`;
  return zeile.id as string;
}

async function grunddaten(tx: Tx) {
  const [bezirk] = await tx`
    insert into bezirk (name) values (${`Bezirk ${randomUUID()}`}) returning id`;
  const einheit = async (typ: "jf" | "kf") =>
    (
      await tx`
        insert into einheit (bezirk_id, typ, name)
        values (${bezirk.id}, ${typ}, ${`Einheit ${typ}`}) returning id`
    )[0].id as string;
  return {
    bezirk: bezirk.id as string,
    jf: await einheit("jf"),
    kf: await einheit("kf"),
    person: await person(tx),
  };
}

const rang = async (tx: Tx, einheit: string, reihenfolge = 1) =>
  (
    await tx`
      insert into rang (einheit_id, name, kuerzel, reihenfolge)
      values (${einheit}, 'Rang', 'R', ${reihenfolge}) returning id`
  )[0].id as string;

test("Löschen einer Person entfernt ihre Rollen, Konto-Verknüpfungen, Sitzungen, Konten und den zweiten Faktor; der Audit-Eintrag über sie bleibt", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const { jf, person: p } = await grunddaten(tx);
    const teilnehmende: string[] = [];
    for (const vorname of ["Erstes", "Zweites"]) {
      const [t] = await tx`
        insert into teilnehmende (einheit_id, vorname, nachname)
        values (${jf}, ${vorname}, 'Test') returning id`;
      await tx`insert into teilnehmende_konto (user_id, teilnehmende_id, art) values (${p}, ${t.id}, 'eltern')`;
      teilnehmende.push(t.id);
    }
    await tx`insert into einheit_rolle (user_id, einheit_id, typ) values (${p}, ${jf}, 'leitung')`;
    await tx`
      insert into session (token, expires_at, updated_at, user_id)
      values (${randomUUID()}, now() + interval '1 day', now(), ${p})`;
    await tx`
      insert into account (account_id, provider_id, user_id, updated_at)
      values (${p}, 'credential', ${p}, now())`;
    await tx`insert into two_factor (secret, backup_codes, user_id) values ('geheim', 'codes', ${p})`;
    await tx`
      insert into audit_log (einheit_id, akteur_id, aktion, ziel_typ, ziel_id)
      values (${jf}, ${p}, 'test', 'user', ${p})`;

    // Eine teilnehmende Person zu löschen entfernt nur ihre eigene Verknüpfung
    await tx`delete from teilnehmende where id = ${teilnehmende[0]}`;
    expect(
      await tx`select teilnehmende_id from teilnehmende_konto where user_id = ${p}`,
    ).toEqual([{ teilnehmende_id: teilnehmende[1] }]);

    await tx`delete from "user" where id = ${p}`;
    const [rest] = await tx`
      select
        (select count(*) from einheit_rolle where user_id = ${p})::int as einheit_rolle,
        (select count(*) from teilnehmende_konto where user_id = ${p})::int as teilnehmende_konto,
        (select count(*) from session where user_id = ${p})::int as session,
        (select count(*) from account where user_id = ${p})::int as account,
        (select count(*) from two_factor where user_id = ${p})::int as two_factor,
        (select count(*) from audit_log where akteur_id = ${p} and ziel_id = ${p})::int as audit_log,
        (select count(*) from teilnehmende where id = ${teilnehmende[1]})::int as teilnehmende`;
    expect(rest).toEqual({
      einheit_rolle: 0,
      teilnehmende_konto: 0,
      session: 0,
      account: 0,
      two_factor: 0,
      audit_log: 1,
      teilnehmende: 1,
    });
  });
});

test("ein Bezirk oder eine Einheit, auf die noch etwas zeigt, lässt sich nicht löschen", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const { bezirk, jf, person: p } = await grunddaten(tx);
    await tx`insert into einheit_rolle (user_id, einheit_id, typ) values (${p}, ${jf}, 'kommandant')`;
    // 23001 restrict_violation: PostgreSQL 18 meldet RESTRICT so, NO ACTION dagegen mit 23503
    await scheitert(
      tx,
      { code: "23001" },
      (sp) => sp`delete from einheit where id = ${jf}`,
    );
    await scheitert(
      tx,
      { code: "23001" },
      (sp) => sp`delete from bezirk where id = ${bezirk}`,
    );
  });
});

test("jeder Fremdschlüssel auf bezirk, einheit oder rang ist RESTRICT", async () => {
  const fremdschluessel = await sql`
    select conname, confdeltype from pg_constraint
    where contype = 'f' and confrelid in ('bezirk'::regclass, 'einheit'::regclass, 'rang'::regclass)`;
  expect(fremdschluessel.length).toBeGreaterThan(0);
  expect(fremdschluessel.filter((f) => f.confdeltype !== "r")).toEqual([]);
});

test("die Datenbank lehnt eine Sitzung mit IP-Adresse oder User-Agent ab", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const { person: p } = await grunddaten(tx);
    const fehler = {
      code: "23514",
      constraint_name: "session_ohne_ip_und_user_agent",
    };
    await scheitert(
      tx,
      fehler,
      (sp) => sp`
        insert into session (token, expires_at, updated_at, user_id, ip_address)
        values (${randomUUID()}, now() + interval '1 day', now(), ${p}, '203.0.113.7')`,
    );
    await scheitert(
      tx,
      fehler,
      (sp) => sp`
        insert into session (token, expires_at, updated_at, user_id, user_agent)
        values (${randomUUID()}, now() + interval '1 day', now(), ${p}, 'Testgeraet/1.0')`,
    );
  });
});

test("Löschen eines Programms entfernt Teilnahmen und Anmeldungen der Leitung", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const { jf, person: p } = await grunddaten(tx);
    const [prog] = await tx`
      insert into programm (einheit_id, google_event_id, titel, ganztaegig, tag_von, tag_bis)
      values (${jf}, 'event00000000001', 'Testlager', true, '2027-07-30', '2027-08-02')
      returning id`;
    const [t] = await tx`
      insert into teilnehmende (einheit_id, vorname, nachname)
      values (${jf}, 'Test', 'Person') returning id`;
    await tx`insert into teilnahme (programm_id, teilnehmende_id, status) values (${prog.id}, ${t.id}, 'ja')`;
    await tx`insert into leitung_anmeldung (programm_id, user_id, status) values (${prog.id}, ${p}, 'nein')`;
    await tx`delete from programm where id = ${prog.id}`;
    const [rest] = await tx`
      select (select count(*) from teilnahme where programm_id = ${prog.id})::int as teilnahme,
             (select count(*) from leitung_anmeldung where programm_id = ${prog.id})::int as leitung`;
    expect(rest).toEqual({ teilnahme: 0, leitung: 0 });
  });
});

test("die Datenbank lehnt ein Programm mit ungültigem Status oder falschen Zeiten ab", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const { jf } = await grunddaten(tx);
    await scheitert(
      tx,
      { code: "23514", constraint_name: "programm_status_check" },
      (sp) => sp`
        insert into programm (einheit_id, google_event_id, titel, ganztaegig, tag_von, tag_bis, status)
        values (${jf}, 'event00000000002', 'Test', true, '2027-07-30', '2027-08-02', 'geplant')`,
    );
    // Ganztägig verlangt Tage und keine Zeitpunkte, sonst das Gegenteil
    const zeiten = {
      code: "23514",
      constraint_name: "programm_zeiten_passen_zu_ganztaegig",
    };
    await scheitert(
      tx,
      zeiten,
      (sp) => sp`
        insert into programm (einheit_id, google_event_id, titel, ganztaegig, beginn, ende)
        values (${jf}, 'event00000000002', 'Test', true, now(), now())`,
    );
    await scheitert(
      tx,
      zeiten,
      (sp) => sp`
        insert into programm (einheit_id, google_event_id, titel, ganztaegig, tag_von, tag_bis)
        values (${jf}, 'event00000000002', 'Test', false, '2027-07-30', '2027-08-02')`,
    );
  });
});

test("dieselbe Google-ID ist je Einheit nur einmal erlaubt, in einer anderen Einheit nicht", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const { jf, kf } = await grunddaten(tx);
    const einfuegen = (einheit: string) => tx`
      insert into programm (einheit_id, google_event_id, titel, ganztaegig, tag_von, tag_bis)
      values (${einheit}, 'event00000000002', 'Einmal', true, '2027-07-30', '2027-08-02')`;
    await einfuegen(jf);
    await einfuegen(kf);
    await scheitert(
      tx,
      {
        code: "23505",
        constraint_name: "programm_einheit_google_event_eindeutig",
      },
      () => einfuegen(jf),
    );
  });
});

test("einheit: nur JF oder KF, je Bezirk höchstens eine von beiden", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const { bezirk } = await grunddaten(tx);
    await scheitert(
      tx,
      { code: "23514", constraint_name: "einheit_typ_check" },
      (sp) => sp`
        insert into einheit (bezirk_id, typ, name) values (${bezirk}, 'xx', 'Falsch')`,
    );
    await scheitert(
      tx,
      { code: "23505", constraint_name: "einheit_bezirk_typ_eindeutig" },
      (sp) => sp`
        insert into einheit (bezirk_id, typ, name) values (${bezirk}, 'jf', 'Zweite JF')`,
    );
  });
});

test("bezirk: Name ohne Gross-/Kleinschreibung eindeutig", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const name = `Meilen ${randomUUID()}`;
    await tx`insert into bezirk (name) values (${name})`;
    await scheitert(
      tx,
      { code: "23505", constraint_name: "bezirk_name_eindeutig" },
      (sp) => sp`insert into bezirk (name) values (${name.toUpperCase()})`,
    );
  });
});

test("einheit_rolle: höchstens ein Kommandant, Reihenfolge nur bei Stellvertretungen und je Einheit eindeutig", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const { jf, kf, person: p1 } = await grunddaten(tx);
    const p2 = await person(tx);
    const p3 = await person(tx);
    await tx`insert into einheit_rolle (user_id, einheit_id, typ) values (${p1}, ${jf}, 'kommandant')`;
    // Ein Kommandant in der anderen Einheit ist erlaubt, ein zweiter in derselben nicht
    await tx`insert into einheit_rolle (user_id, einheit_id, typ) values (${p1}, ${kf}, 'kommandant')`;
    await scheitert(
      tx,
      { code: "23505", constraint_name: "einheit_rolle_ein_kommandant" },
      (sp) =>
        sp`insert into einheit_rolle (user_id, einheit_id, typ) values (${p2}, ${jf}, 'kommandant')`,
    );
    const reihenfolge = {
      code: "23514",
      constraint_name: "einheit_rolle_reihenfolge_check",
    };
    await scheitert(
      tx,
      reihenfolge,
      (sp) =>
        sp`insert into einheit_rolle (user_id, einheit_id, typ, reihenfolge) values (${p2}, ${jf}, 'leitung', 1)`,
    );
    await scheitert(
      tx,
      reihenfolge,
      (sp) =>
        sp`insert into einheit_rolle (user_id, einheit_id, typ) values (${p2}, ${jf}, 'stellvertretung')`,
    );
    await tx`insert into einheit_rolle (user_id, einheit_id, typ, reihenfolge) values (${p2}, ${jf}, 'stellvertretung', 1)`;
    await scheitert(
      tx,
      {
        code: "23505",
        constraint_name: "einheit_rolle_reihenfolge_eindeutig",
      },
      (sp) =>
        sp`insert into einheit_rolle (user_id, einheit_id, typ, reihenfolge) values (${p3}, ${jf}, 'stellvertretung', 1)`,
    );
    await scheitert(
      tx,
      { code: "23514", constraint_name: "einheit_rolle_typ_check" },
      (sp) =>
        sp`insert into einheit_rolle (user_id, einheit_id, typ) values (${p3}, ${jf}, 'admin')`,
    );
    // Eine Person hat je Einheit höchstens eine Rolle
    await scheitert(
      tx,
      { code: "23505" },
      (sp) =>
        sp`insert into einheit_rolle (user_id, einheit_id, typ) values (${p2}, ${jf}, 'leitung')`,
    );
  });
});

test("der Rang einer Rolle oder einer teilnehmenden Person gehört zur selben Einheit", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const { jf, kf, person: p } = await grunddaten(tx);
    const rangJf = await rang(tx, jf);
    const rangKf = await rang(tx, kf);
    await tx`insert into einheit_rolle (user_id, einheit_id, typ, rang_id) values (${p}, ${jf}, 'leitung', ${rangJf})`;
    await tx`insert into teilnehmende (einheit_id, vorname, nachname, rang_id) values (${jf}, 'A', 'B', ${rangJf})`;
    // Der Rang der anderen Einheit: zusammengesetzter Fremdschlüssel schlägt an
    await scheitert(
      tx,
      { code: "23503", constraint_name: "einheit_rolle_rang_der_einheit" },
      (sp) =>
        sp`update einheit_rolle set rang_id = ${rangKf} where user_id = ${p}`,
    );
    await scheitert(
      tx,
      { code: "23503", constraint_name: "teilnehmende_rang_der_einheit" },
      (sp) =>
        sp`insert into teilnehmende (einheit_id, vorname, nachname, rang_id) values (${jf}, 'C', 'D', ${rangKf})`,
    );
    // Ohne Rang ist erlaubt
    await tx`insert into teilnehmende (einheit_id, vorname, nachname) values (${jf}, 'E', 'F')`;
    // Ein Rang, der noch gebraucht wird, lässt sich nicht löschen
    await scheitert(
      tx,
      { code: "23001" },
      (sp) => sp`delete from rang where id = ${rangJf}`,
    );
    await tx`delete from rang where id = ${rangKf}`;
  });
});

test("rang: Reihenfolge 1 bis 999 und je Einheit eindeutig, Abzeichen entweder Sterne oder Bild", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const { jf } = await grunddaten(tx);
    await rang(tx, jf, 1);
    await scheitert(
      tx,
      { code: "23505", constraint_name: "rang_reihenfolge_pro_einheit" },
      () => rang(tx, jf, 1),
    );
    for (const ungueltig of [0, 1000]) {
      await scheitert(
        tx,
        { code: "23514", constraint_name: "rang_reihenfolge_check" },
        () => rang(tx, jf, ungueltig),
      );
    }
    await scheitert(
      tx,
      { code: "23514", constraint_name: "rang_sterne_check" },
      (sp) => sp`
        insert into rang (einheit_id, name, kuerzel, reihenfolge, abzeichen_sterne)
        values (${jf}, 'S', 'S', 2, 6)`,
    );
    await tx`
      insert into rang (einheit_id, name, kuerzel, reihenfolge, abzeichen_sterne)
      values (${jf}, 'S', 'S', 2, 0)`;
    await scheitert(
      tx,
      { code: "23514", constraint_name: "rang_abzeichen_eines" },
      (sp) => sp`
        insert into rang (einheit_id, name, kuerzel, reihenfolge, abzeichen_sterne, abzeichen_bild, abzeichen_bild_typ)
        values (${jf}, 'B', 'B', 3, 1, decode('00', 'hex'), 'png')`,
    );
    // Bild nur mit erlaubtem Typ und höchstens 500 KB
    await scheitert(
      tx,
      { code: "23514", constraint_name: "rang_bild_typ_check" },
      (sp) => sp`
        insert into rang (einheit_id, name, kuerzel, reihenfolge, abzeichen_bild, abzeichen_bild_typ)
        values (${jf}, 'B', 'B', 3, decode('00', 'hex'), 'gif')`,
    );
    await scheitert(
      tx,
      { code: "23514", constraint_name: "rang_bild_typ_check" },
      (sp) => sp`
        insert into rang (einheit_id, name, kuerzel, reihenfolge, abzeichen_bild, abzeichen_bild_typ)
        values (${jf}, 'B', 'B', 3, decode(repeat('00', 512001), 'hex'), 'png')`,
    );
    await tx`
      insert into rang (einheit_id, name, kuerzel, reihenfolge, abzeichen_bild, abzeichen_bild_typ)
      values (${jf}, 'B', 'B', 3, decode('00', 'hex'), 'svg')`;
  });
});

test("teilnehmende_konto: Art eltern oder selbst, höchstens ein eigenes Konto je teilnehmende Person", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const { jf, person: p1 } = await grunddaten(tx);
    const p2 = await person(tx);
    const p3 = await person(tx);
    const [t] = await tx`
      insert into teilnehmende (einheit_id, vorname, nachname)
      values (${jf}, 'Test', 'Person') returning id`;
    await scheitert(
      tx,
      { code: "23514", constraint_name: "teilnehmende_konto_art_check" },
      (sp) =>
        sp`insert into teilnehmende_konto (user_id, teilnehmende_id, art) values (${p1}, ${t.id}, 'kind')`,
    );
    // Zwei Elternteile sind erlaubt
    await tx`insert into teilnehmende_konto (user_id, teilnehmende_id, art) values (${p1}, ${t.id}, 'eltern')`;
    await tx`insert into teilnehmende_konto (user_id, teilnehmende_id, art) values (${p2}, ${t.id}, 'eltern')`;
    await tx`insert into teilnehmende_konto (user_id, teilnehmende_id, art) values (${p3}, ${t.id}, 'selbst')`;
    const p4 = await person(tx);
    await scheitert(
      tx,
      { code: "23505", constraint_name: "teilnehmende_konto_ein_selbst" },
      (sp) =>
        sp`insert into teilnehmende_konto (user_id, teilnehmende_id, art) values (${p4}, ${t.id}, 'selbst')`,
    );
  });
});

test("user: Benutzername 3 bis 64 Zeichen aus Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich, kleingeschrieben", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const eindeutig = randomUUID().slice(0, 8);
    await person(tx, `ok.name_${eindeutig}-1`);
    await person(tx, undefined);
    const regel = { code: "23514", constraint_name: "user_username_regel" };
    for (const ungueltig of [
      "ab",
      "a".repeat(65),
      `Gross${eindeutig}`,
      `mit leerzeichen ${eindeutig}`,
      `umlaut${eindeutig}ä`,
      `semi;${eindeutig}`,
    ]) {
      await scheitert(tx, regel, () => person(tx, ungueltig));
    }
    // Der Name ist systemweit eindeutig
    await scheitert(tx, { code: "23505" }, () =>
      person(tx, `ok.name_${eindeutig}-1`),
    );
  });
});

test("user: Einwilligung gibt es nur mit Datum und Version zusammen", async () => {
  await zurueckgerollt(sql, async (tx) => {
    const einfuegen = (am: string | null, version: number | null) => tx`
      insert into "user" (name, email, einwilligung_am, einwilligung_version)
      values ('Test', ${`${randomUUID()}@example.org`}, ${am}, ${version})`;
    await einfuegen(null, null);
    await einfuegen("2027-01-01T00:00:00Z", 1);
    const fehler = {
      code: "23514",
      constraint_name: "user_einwilligung_zusammen",
    };
    await scheitert(tx, fehler, () => einfuegen("2027-01-01T00:00:00Z", null));
    await scheitert(tx, fehler, () => einfuegen(null, 1));
  });
});
