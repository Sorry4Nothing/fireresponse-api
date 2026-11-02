import type { Sql, TransactionSql } from "postgres";
import { expect } from "vitest";

const ZURUECK = new Error("zurückrollen");

// Jede Prüfung in einer Transaktion, die am Ende zurückrollt
export async function zurueckgerollt(
  sql: Sql,
  pruefung: (tx: TransactionSql) => Promise<void>,
) {
  await sql
    .begin(async (tx) => {
      await pruefung(tx);
      throw ZURUECK;
    })
    .catch((fehler) => {
      if (fehler !== ZURUECK) throw fehler;
    });
}

// Im eigenen Savepoint, damit die Transaktion nach dem Fehler weiterläuft
export async function scheitert(
  tx: TransactionSql,
  fehler: { code: string; constraint_name?: string },
  anweisung: (sp: TransactionSql) => Promise<unknown>,
) {
  await expect(tx.savepoint(anweisung)).rejects.toMatchObject(fehler);
}
