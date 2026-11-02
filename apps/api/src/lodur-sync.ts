import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, sql as roh } from "drizzle-orm";
import { verbindeDatenbank } from "./datenbank.js";
import { erstelleDb, type Db } from "./db/client.js";
import { einheit, programm } from "./db/schema.js";
import { IcsFehler, leseIcs, type IcsErgebnis, type IcsTermin } from "./ics.js";
import {
  holeKalender,
  LodurFehler,
  pruefeAdresse,
  pruefeLodurUrl,
  ZWECK_LODUR_LINK,
  type Abruf,
  type Aufloesen,
} from "./lodur-url.js";
import { fehlerCode, log } from "./log.js";
import type { Fcm } from "./push.js";
import { programmBeginn } from "./rechte.js";
import { entschluessele } from "./startpasswort.js";
import { sendeAbsagePush, sendeAenderungsPush } from "./termin-push.js";

// Eigener Schlüssel für die Sperre; 740027 und 740028 bleiben für spätere Hintergrundläufe frei
export const SPERRE_LODUR = 740_030;
export const SYNC_TAKT_MS = 15 * 60 * 1000;

export type SyncOptionen = {
  db: Db;
  fcm?: Fcm;
  erlaubteHosts: readonly string[];
  abruf?: Abruf;
  aufloesen?: Aufloesen;
};

// Was der Sync ändern darf, gehört in diesen Hash; «Verantwortlich» fehlt, weil es nie gespeichert wird
export const inhaltHash = (t: IcsTermin) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        t.titel,
        t.ganztaegig,
        t.beginn?.toISOString() ?? null,
        t.ende?.toISOString() ?? null,
        t.tagVon,
        t.tagBis,
        t.thema,
        t.info,
        t.aufgebot,
      ]),
    )
    .digest("hex");

const felder = (t: IcsTermin) => ({
  titel: t.titel,
  ganztaegig: t.ganztaegig,
  beginn: t.beginn,
  ende: t.ende,
  tagVon: t.tagVon,
  tagBis: t.tagBis,
  thema: t.thema,
  info: t.info,
  aufgebot: t.aufgebot,
  inhaltHash: inhaltHash(t),
});

type Vorhanden = {
  id: string;
  uid: string;
  hash: string | null;
  status: "aktiv" | "abgesagt" | "pruefen";
  // Millisekunden statt Zeitstempel: Der Treiber liefert Zeitstempel als Text
  beginnMs: string;
};

// Gleicht die Termine einer Einheit mit dem Kalender ab und schickt danach die Pushes. Künftig heisst: Beginn nach jetzt; was begonnen hat, fasst der Sync nie an
export async function uebernimm(
  { db, fcm }: { db: Db; fcm?: Fcm },
  einheitId: string,
  kalender: IcsErgebnis,
  jetzt: Date,
) {
  const vorhanden: Vorhanden[] = await db
    .select({
      id: programm.id,
      uid: programm.googleEventId,
      hash: programm.inhaltHash,
      status: programm.status,
      beginnMs: roh<string>`(extract(epoch from ${programmBeginn}) * 1000)::bigint`,
    })
    .from(programm)
    .where(eq(programm.einheitId, einheitId));
  const nachUid = new Map(vorhanden.map((v) => [v.uid, v]));
  const kuenftig = (v: Vorhanden) => Number(v.beginnMs) > jetzt.getTime();

  const abgesagt = vorhanden.filter(
    (v) => kuenftig(v) && v.status === "aktiv" && !kalender.uids.has(v.uid),
  );
  // Ein leerer Kalender neben künftigen Terminen ist eher ein Fehler in Lodur als eine Absage aller Termine
  if (kalender.uids.size === 0 && abgesagt.length > 0) {
    throw new LodurFehler("leer");
  }
  const neu = kalender.termine.filter((t) => !nachUid.has(t.uid));
  const geaendert = kalender.termine.flatMap((t) => {
    const v = nachUid.get(t.uid);
    return v &&
      kuenftig(v) &&
      (v.hash !== inhaltHash(t) || v.status !== "aktiv")
      ? [{ v, t }]
      : [];
  });

  await db.transaction(async (tx) => {
    if (neu.length > 0) {
      await tx
        .insert(programm)
        .values(
          neu.map((t) => ({ einheitId, googleEventId: t.uid, ...felder(t) })),
        )
        .onConflictDoNothing();
    }
    for (const { v, t } of geaendert) {
      await tx
        .update(programm)
        .set({ ...felder(t), status: "aktiv" })
        .where(eq(programm.id, v.id));
    }
    if (abgesagt.length > 0) {
      await tx
        .update(programm)
        .set({ status: "abgesagt" })
        .where(
          inArray(
            programm.id,
            abgesagt.map((v) => v.id),
          ),
        );
    }
    await tx
      .update(einheit)
      .set({ syncOkAm: jetzt, syncFehler: null })
      .where(eq(einheit.id, einheitId));
  });

  if (!fcm) return;
  // Nach dem Speichern, und ohne Inhalt (siehe termin-push.ts). Stürzt der Prozess dazwischen ab, fällt dieser Push aus. Ohne Antworten bleibt die Änderung still
  for (const { v } of geaendert)
    await sendeAenderungsPush({ db, fcm, jetzt }, v.id);
  for (const v of abgesagt) await sendeAbsagePush({ db, fcm, jetzt }, v.id);
}

// Ein Abruf: entschlüsseln, prüfen, holen, lesen, übernehmen. Wirft LodurFehler mit dem einen Code
export async function synchronisiereEinheit(
  { db, fcm, erlaubteHosts, abruf, aufloesen }: SyncOptionen,
  einheitId: string,
  verschluesselt: string,
  jetzt = new Date(),
) {
  const link = entschluessele(verschluesselt, ZWECK_LODUR_LINK);
  if (link === null) throw new LodurFehler("entschluesselung");
  // Die Allowlist gilt bei jedem Abruf, nicht nur beim Speichern: Sie kann sich seither geändert haben
  const url = pruefeLodurUrl(link, erlaubteHosts);
  await pruefeAdresse(url.hostname, aufloesen);
  let kalender: IcsErgebnis;
  try {
    kalender = leseIcs(await holeKalender(url, abruf));
  } catch (fehler) {
    throw fehler instanceof IcsFehler
      ? new LodurFehler("kein-kalender")
      : fehler;
  }
  await uebernimm({ db, fcm }, einheitId, kalender, jetzt);
}

// Ein Lauf über alle Einheiten mit Link; eine Einheit, die scheitert, hält die nächste nicht auf. «gesperrt» heisst: ein anderer Lauf arbeitet gerade. einheitIds begrenzt den Lauf (Tests teilen sich die Datenbank)
export async function syncLodur({
  datenbankUrl,
  einheitIds,
  jetzt = new Date(),
  ...optionen
}: Omit<SyncOptionen, "db"> & {
  datenbankUrl: string;
  einheitIds?: string[];
  jetzt?: Date;
}): Promise<"fertig" | "gesperrt"> {
  // Eigene Verbindung mit max 1: Sperre und Freigabe müssen auf derselben Sitzung laufen
  const sql = verbindeDatenbank(datenbankUrl, { max: 1 });
  try {
    const [sperre] =
      await sql`select pg_try_advisory_lock(${SPERRE_LODUR}) as erhalten`;
    if (!sperre.erhalten) return "gesperrt";
    try {
      const db = erstelleDb(sql);
      const liste = await db
        .select({
          id: einheit.id,
          verschluesselt: einheit.lodurUrlVerschluesselt,
        })
        .from(einheit)
        .where(
          and(
            isNotNull(einheit.lodurUrlVerschluesselt),
            einheitIds && inArray(einheit.id, einheitIds),
          ),
        );
      for (const e of liste) {
        try {
          await synchronisiereEinheit(
            { db, ...optionen },
            e.id,
            e.verschluesselt!,
            jetzt,
          );
        } catch (fehler) {
          // Nur der Code, nie die Meldung: Sie könnte den Link oder SQL-Parameter nennen
          const code = fehler instanceof LodurFehler ? fehler.code : "intern";
          log(undefined, {
            ereignis: "lodur-sync",
            code,
            ...(code === "intern" && { ursache: fehlerCode(fehler) }),
          });
          await db
            .update(einheit)
            .set({ syncFehler: code })
            .where(eq(einheit.id, e.id))
            .catch(() => {});
        }
      }
      return "fertig";
    } finally {
      // Scheitert nur mit der Verbindung, und dann fällt die Sperre mit ihr
      await sql`select pg_advisory_unlock(${SPERRE_LODUR})`.catch(() => {});
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Startet den Lauf sofort und dann alle 15 Minuten (Rücksicht auf Lodur); Erfolg und «gesperrt» bleiben still
export function starteLodurSync(lauf: () => Promise<unknown>) {
  const starte = () =>
    lauf().catch((fehler) =>
      log(undefined, { ereignis: "lodur-sync", code: fehlerCode(fehler) }),
    );
  void starte();
  return setInterval(starte, SYNC_TAKT_MS);
}
