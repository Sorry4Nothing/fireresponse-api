import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "./db/client.js";
import {
  bezirk,
  einheit,
  einheitRolle,
  leitungAnmeldung,
  programm,
  teilnahme,
  teilnehmende,
  user,
} from "./db/schema.js";
import { anmeldbar } from "./anmeldefenster.js";
import { ladeAdminRaenge, type AdminRang } from "./rang-anzeige.js";
import { aktivesKonto, programmBeginn } from "./rechte.js";

// Die Auswertung zählt nur Anmeldungen, nie Anwesenheit. Bezugsgrösse sind aktive Programme mit Anmeldung (freigegebene Art), die schon begonnen haben: Bei künftigen Terminen sagt «offen» noch nichts, abgesagte zählen nicht. Inaktive Teilnehmende und deaktivierte Konten fehlen überall. Die Zahlen hängen an der Person (teilnehmende), nie am antwortenden Konto: Ein Wechsel von den Eltern aufs Kind ändert sie nicht

export type Bereich = {
  // Immer schon auf das Recht der Person gefiltert (einheitenFuer «verwalten»)
  einheiten: string[];
  bezirkId?: string;
  // Schweizer Kalendertage, inklusive
  von: string;
  bis: string;
};

export type Zahlen = { ja: number; nein: number; offen: number };
export type ZahlenMitQuote = Zahlen & { quote: number | null };
export type Antwort = "ja" | "nein" | "offen";

// Der Schweizer Kalendertag, an dem das Programm beginnt; ein Lager zählt einmal, an seinem ersten Tag
const beginnTag = sql`coalesce(${programm.tagVon}, (${programm.beginn} at time zone 'Europe/Zurich')::date)`;
const begonnen = sql`${programmBeginn} <= now()`;

// Gerundet auf drei Stellen; ohne Bezug keine Quote
export const quote = (ja: number, summe: number) =>
  summe === 0 ? null : Math.round((ja / summe) * 1000) / 1000;

export const mitQuote = (z: Zahlen): ZahlenMitQuote => ({
  ja: z.ja,
  nein: z.nein,
  offen: z.offen,
  quote: quote(z.ja, z.ja + z.nein + z.offen),
});

// Programme des Bereichs mit Anmeldung (freigegebene Art); mit nurBezug nur die, die in die Quote zählen. Setzt einen Join auf einheit voraus
export function programmeIn(b: Bereich, nurBezug: boolean): SQL {
  return sql`${inArray(programm.einheitId, b.einheiten)}
    ${b.bezirkId === undefined ? sql`` : sql`and ${eq(einheit.bezirkId, b.bezirkId)}`}
    and ${anmeldbar}
    and ${beginnTag} between ${b.von}::date and ${b.bis}::date
    ${nurBezug ? sql`and ${programm.status} = 'aktiv' and ${begonnen}` : sql``}`;
}

// FROM-Teile für db.execute, weil sich ein Select-Builder mit Joins nicht typsicher teilen lässt. Teilnehmende gegen Programme derselben Einheit; ohne Zeile in teilnahme gilt «offen» (status null)
const vonTeilnehmenden = sql`from ${programm}
  join ${einheit} on ${einheit.id} = ${programm.einheitId}
  join ${teilnehmende} on ${teilnehmende.einheitId} = ${programm.einheitId} and ${teilnehmende.inaktivSeit} is null
  left join ${teilnahme} on ${teilnahme.programmId} = ${programm.id} and ${teilnahme.teilnehmendeId} = ${teilnehmende.id}`;

// Alle mit Rolle in der Einheit, deren Konto aktiv ist; ohne Zeile in leitung_anmeldung gilt «offen»
const vonLeitenden = sql`from ${programm}
  join ${einheit} on ${einheit.id} = ${programm.einheitId}
  join ${einheitRolle} on ${einheitRolle.einheitId} = ${programm.einheitId}
  join ${user} on ${user.id} = ${einheitRolle.userId} and ${aktivesKonto()}
  left join ${leitungAnmeldung} on ${leitungAnmeldung.programmId} = ${programm.id} and ${leitungAnmeldung.userId} = ${user.id}`;

const zaehler = (status: SQL) => sql`
  count(*) filter (where ${status} = 'ja')::int as "ja",
  count(*) filter (where ${status} = 'nein')::int as "nein",
  count(*) filter (where ${status} is null)::int as "offen"`;

const zaehlerTn = zaehler(sql`${teilnahme.status}`);
const zaehlerLe = zaehler(sql`${leitungAnmeldung.status}`);

export type PersonenZeile = {
  art: "teilnehmende" | "leitende";
  id: string;
  name: string;
  rolle: "kommandant" | "stellvertretung" | "leitung" | null;
  rang: AdminRang | null;
  einheit: { id: string; name: string; typ: "jf" | "kf" };
  termine: number;
} & ZahlenMitQuote;

type PersonRoh = Zahlen & {
  id: string;
  name: string;
  rolle: PersonenZeile["rolle"];
  rangId: string | null;
  einheitId: string;
  einheitName: string;
  einheitTyp: "jf" | "kf";
};

const alsZeile = (
  art: PersonenZeile["art"],
  z: PersonRoh,
  raenge: Map<string, AdminRang>,
): PersonenZeile => ({
  art,
  id: z.id,
  name: z.name,
  rolle: z.rolle,
  rang: (z.rangId && raenge.get(z.rangId)) || null,
  einheit: { id: z.einheitId, name: z.einheitName, typ: z.einheitTyp },
  termine: z.ja + z.nein + z.offen,
  ...mitQuote(z),
});

// Eine Zeile je Person mit ihren Anmeldungen im Zeitraum
export async function quotenTeilnehmende(
  db: Db,
  b: Bereich,
): Promise<PersonenZeile[]> {
  const zeilen = await db.execute<PersonRoh>(sql`
    select ${teilnehmende.id} as "id",
      ${teilnehmende.vorname} || ' ' || ${teilnehmende.nachname} as "name",
      null as "rolle", ${teilnehmende.rangId} as "rangId",
      ${einheit.id} as "einheitId", ${einheit.name} as "einheitName", ${einheit.typ} as "einheitTyp",
      ${zaehlerTn}
    ${vonTeilnehmenden}
    where ${programmeIn(b, true)}
    group by ${teilnehmende.id}, ${einheit.id}
    order by ${einheit.name}, ${teilnehmende.nachname}, ${teilnehmende.vorname}, ${teilnehmende.id}`);
  const raenge = await ladeAdminRaenge(
    db,
    zeilen.map((z) => z.rangId),
  );
  return zeilen.map((z) => alsZeile("teilnehmende", z, raenge));
}

export async function quotenLeitende(
  db: Db,
  b: Bereich,
): Promise<PersonenZeile[]> {
  const zeilen = await db.execute<PersonRoh>(sql`
    select ${user.id} as "id", ${user.name} as "name", ${einheitRolle.typ} as "rolle", ${einheitRolle.rangId} as "rangId",
      ${einheit.id} as "einheitId", ${einheit.name} as "einheitName", ${einheit.typ} as "einheitTyp",
      ${zaehlerLe}
    ${vonLeitenden}
    where ${programmeIn(b, true)}
    group by ${user.id}, ${einheit.id}, ${einheitRolle.typ}, ${einheitRolle.rangId}
    order by ${einheit.name}, ${user.name}, ${user.id}`);
  const raenge = await ladeAdminRaenge(
    db,
    zeilen.map((z) => z.rangId),
  );
  return zeilen.map((z) => alsZeile("leitende", z, raenge));
}

export type JahrZeile = {
  einheit: {
    id: string;
    name: string;
    typ: "jf" | "kf";
    bezirk: { id: string; name: string };
  };
  // Aktive, begonnene Programme (Bezug der Quote) und aktive, noch nicht begonnene
  termine: number;
  kommend: number;
  teilnehmende: ZahlenMitQuote | null;
  leitende: ZahlenMitQuote | null;
  monate: {
    monat: number;
    termine: number;
    teilnehmende: ZahlenMitQuote | null;
    leitende: ZahlenMitQuote | null;
  }[];
};

type MonatsZahlen = Zahlen & { einheitId: string; monat: number };

const leer = (): Zahlen => ({ ja: 0, nein: 0, offen: 0 });

// Jahresübersicht: alle Einheiten des Bereichs, auch ohne Programme; je Einheit die Summe und zwölf Monate
export async function jahresuebersicht(
  db: Db,
  b: Bereich,
  rolle: "teilnehmende" | "leitende" | undefined,
): Promise<JahrZeile[]> {
  const einheiten = await db
    .select({
      id: einheit.id,
      name: einheit.name,
      typ: einheit.typ,
      bezirkId: bezirk.id,
      bezirkName: bezirk.name,
    })
    .from(einheit)
    .innerJoin(bezirk, eq(bezirk.id, einheit.bezirkId))
    .where(
      and(
        inArray(einheit.id, b.einheiten),
        b.bezirkId === undefined ? undefined : eq(einheit.bezirkId, b.bezirkId),
      ),
    )
    .orderBy(asc(bezirk.name), asc(einheit.typ), asc(einheit.name));

  const monat = sql`extract(month from ${beginnTag})::int`;
  const proMonat = (von: SQL, z: SQL) =>
    db.execute<MonatsZahlen>(sql`
      select ${programm.einheitId} as "einheitId", ${monat} as "monat", ${z}
      ${von}
      where ${programmeIn(b, true)}
      group by ${programm.einheitId}, ${monat}`);
  const [termine, tn, le] = await Promise.all([
    db.execute<{
      einheitId: string;
      monat: number;
      bezug: number;
      kommend: number;
    }>(sql`
      select ${programm.einheitId} as "einheitId", ${monat} as "monat",
        count(*) filter (where ${programm.status} = 'aktiv' and ${begonnen})::int as "bezug",
        count(*) filter (where ${programm.status} = 'aktiv' and not ${begonnen})::int as "kommend"
      from ${programm}
      join ${einheit} on ${einheit.id} = ${programm.einheitId}
      where ${programmeIn(b, false)}
      group by ${programm.einheitId}, ${monat}`),
    rolle === "leitende" ? [] : proMonat(vonTeilnehmenden, zaehlerTn),
    rolle === "teilnehmende" ? [] : proMonat(vonLeitenden, zaehlerLe),
  ]);

  return einheiten.map((e) => {
    const von = <T extends { einheitId: string }>(l: T[]) =>
      l.filter((z) => z.einheitId === e.id);
    const t = von([...termine]);
    const summe = (l: Zahlen[]) => {
      const z = leer();
      for (const r of l) {
        z.ja += r.ja;
        z.nein += r.nein;
        z.offen += r.offen;
      }
      return mitQuote(z);
    };
    const tnE = von([...tn]);
    const leE = von([...le]);
    const imMonat = (l: MonatsZahlen[], m: number) =>
      mitQuote(l.find((r) => r.monat === m) ?? leer());
    return {
      einheit: {
        id: e.id,
        name: e.name,
        typ: e.typ,
        bezirk: { id: e.bezirkId, name: e.bezirkName },
      },
      termine: t.reduce((s, z) => s + z.bezug, 0),
      kommend: t.reduce((s, z) => s + z.kommend, 0),
      teilnehmende: rolle === "leitende" ? null : summe(tnE),
      leitende: rolle === "teilnehmende" ? null : summe(leE),
      monate: Array.from({ length: 12 }, (_, i) => ({
        monat: i + 1,
        termine: t.find((z) => z.monat === i + 1)?.bezug ?? 0,
        teilnehmende: rolle === "leitende" ? null : imMonat(tnE, i + 1),
        leitende: rolle === "teilnehmende" ? null : imMonat(leE, i + 1),
      })),
    };
  });
}
