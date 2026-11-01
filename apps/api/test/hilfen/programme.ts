import { randomUUID } from "node:crypto";
import type { Db } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";

export interface TestProgramm {
  id: string;
  // Eindeutige Google-Beschreibung: Taucht die Marke in einer Antwort auf, stammt sie sicher aus diesem Programm
  marke: string;
}

// Legt ein Programm einer Einheit an; mit tagVon ganztägig, sonst mit Zeit. Daten 2027, damit kein Fenster-Test versehentlich trifft
export async function legeProgrammAn(
  db: Db,
  {
    einheitId,
    titel = "Testprogramm",
    beginn = new Date("2027-03-06T13:00:00Z"),
    ende,
    tagVon,
    tagBis,
  }: {
    einheitId: string;
    titel?: string;
    beginn?: Date;
    ende?: Date;
    tagVon?: string;
    tagBis?: string;
  },
): Promise<TestProgramm> {
  const marke = `marke-${randomUUID()}`;
  const ganztaegig = tagVon !== undefined;
  const [zeile] = await db
    .insert(schema.programm)
    .values({
      einheitId,
      googleEventId: `test-${randomUUID()}`,
      titel,
      ganztaegig,
      beginn: ganztaegig ? null : beginn,
      ende: ganztaegig
        ? null
        : (ende ?? new Date(beginn.getTime() + 7_200_000)),
      tagVon: ganztaegig ? tagVon : null,
      tagBis: ganztaegig ? (tagBis ?? tagVon) : null,
      googleOrt: "Google-Ort",
      googleBeschreibung: marke,
    })
    .returning({ id: schema.programm.id });
  return { id: zeile.id, marke };
}
