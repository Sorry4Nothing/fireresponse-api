import { randomUUID } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";
import {
  erzeugeStartpasswort,
  normalisiereStartpasswort,
  startpasswortFelder,
} from "../../src/startpasswort.js";
import {
  APP,
  cookiesAus,
  erstelleTestAuth,
  PASSWORT,
  zufallsIp,
} from "./auth.js";

// Die 14 Personas der Rechte-Matrix, in der Reihenfolge des Matrix-Tests
export const PERSONAS = [
  "admin",
  "adminOhneZweitenFaktor",
  "slA",
  "slB",
  "leitendeA",
  "leitendeB",
  "leitendeAElternB",
  "elternA",
  "elternB",
  "mussPasswortAendern",
  "deaktiviert",
  "ohneLogin",
  "demoAdmin",
  "demoEltern",
] as const;

export type Persona = (typeof PERSONAS)[number];

type TestAuth = ReturnType<typeof erstelleTestAuth>;

export interface Welt {
  db: Db;
  auth: TestAuth;
  testabteilungId: string;
  demoAbteilungId: string;
  stufeAId: string;
  stufeBId: string;
  demoStufeId: string;
  kindAId: string;
  kindBId: string;
  demoKindId: string;
}

// Eine Welt pro Testdatei: Die Dateien laufen parallel und teilen sich so keine Zeilen
export async function erstelleWelt(db: Db, auth: TestAuth): Promise<Welt> {
  const abteilung = (name: string) =>
    db.insert(schema.abteilung).values({ name }).returning();
  const [testabteilung] = await abteilung("Testabteilung");
  const [demoAbteilung] = await abteilung("Demo-Abteilung");

  const stufe = (abteilungId: string, name: string, kuerzel: string) =>
    db.insert(schema.stufe).values({ abteilungId, name, kuerzel }).returning();
  const [stufeA] = await stufe(testabteilung.id, "Stufe A", "A");
  const [stufeB] = await stufe(testabteilung.id, "Stufe B", "B");
  const [demoStufe] = await stufe(demoAbteilung.id, "Demo-Stufe", "D");

  const kind = (abteilungId: string, nachname: string, stufeId: string) =>
    db
      .insert(schema.kind)
      .values({ abteilungId, vorname: "Kind", nachname, stufeId })
      .returning();
  const [kindA] = await kind(testabteilung.id, "A", stufeA.id);
  const [kindB] = await kind(testabteilung.id, "B", stufeB.id);
  const [demoKind] = await kind(demoAbteilung.id, "Demo", demoStufe.id);

  return {
    db,
    auth,
    testabteilungId: testabteilung.id,
    demoAbteilungId: demoAbteilung.id,
    stufeAId: stufeA.id,
    stufeBId: stufeB.id,
    demoStufeId: demoStufe.id,
    kindAId: kindA.id,
    kindBId: kindB.id,
    demoKindId: demoKind.id,
  };
}

export interface PersonaKonto {
  id: string | null;
  benutzername: string | null;
  passwort: string | null;
  abteilungId: string | null;
  // Kopfzeilen wie vom Expo-Client: Herkunft im App-Schema und das gespeicherte Cookie
  headers: Record<string, string>;
}

interface Steckbrief {
  name: string;
  benutzername: string;
  demo?: true;
  admin?: true;
  zweiterFaktor?: true;
  rollen?: readonly (readonly ["A" | "B", "leitung" | "stufenleitung"])[];
  elternVon?: readonly ("A" | "B" | "Demo")[];
  mussPasswortAendern?: true;
  deaktivieren?: true;
}

const STECKBRIEFE: Record<Exclude<Persona, "ohneLogin">, Steckbrief> = {
  admin: {
    name: "Admin",
    benutzername: "admin",
    admin: true,
    zweiterFaktor: true,
  },
  adminOhneZweitenFaktor: {
    name: "Admin ohne zweiten Faktor",
    benutzername: "admin.ohne",
    admin: true,
  },
  slA: { name: "SL A", benutzername: "sl.a", rollen: [["A", "stufenleitung"]] },
  slB: { name: "SL B", benutzername: "sl.b", rollen: [["B", "stufenleitung"]] },
  leitendeA: {
    name: "Leitende A",
    benutzername: "leitende.a",
    rollen: [["A", "leitung"]],
  },
  leitendeB: {
    name: "Leitende B",
    benutzername: "leitende.b",
    rollen: [["B", "leitung"]],
  },
  leitendeAElternB: {
    name: "Leitende A und zugleich Elternteil B",
    benutzername: "leitende.a.eltern.b",
    rollen: [["A", "leitung"]],
    elternVon: ["B"],
  },
  elternA: { name: "Eltern A", benutzername: "eltern.a", elternVon: ["A"] },
  elternB: { name: "Eltern B", benutzername: "eltern.b", elternVon: ["B"] },
  mussPasswortAendern: {
    name: "Muss Passwort ändern",
    benutzername: "muss.wechseln",
    elternVon: ["A"],
    mussPasswortAendern: true,
  },
  deaktiviert: {
    name: "Deaktiviert",
    benutzername: "deaktiviert",
    elternVon: ["A"],
    deaktivieren: true,
  },
  demoAdmin: {
    name: "Admin der Demo-Abteilung",
    benutzername: "demo.admin",
    demo: true,
    admin: true,
    zweiterFaktor: true,
  },
  demoEltern: {
    name: "Eltern der Demo-Abteilung",
    benutzername: "demo.eltern",
    demo: true,
    elternVon: ["Demo"],
  },
};

// Der aktuelle Code der Person, aus dem gespeicherten und entschlüsselten Geheimnis
export async function totpCode(welt: Welt, userId: string) {
  const { auth, db } = welt;
  const [{ secret }] = await db
    .select({ secret: schema.twoFactor.secret })
    .from(schema.twoFactor)
    .where(eq(schema.twoFactor.userId, userId));
  const { code } = await auth.api.generateTOTP({
    body: {
      secret: await symmetricDecrypt({
        key: (await auth.$context).secretConfig,
        data: secret,
      }),
    },
  });
  return code;
}

// Schaltet den zweiten Faktor in der laufenden Sitzung ein; das neue Cookie ersetzt das der Anmeldung
async function zweiterFaktorEin(welt: Welt, userId: string, cookie: string) {
  const { auth } = welt;
  const headers = { cookie };
  await auth.api.enableTwoFactor({ body: { password: PASSWORT }, headers });
  const bestaetigt = await auth.api.verifyTOTP({
    body: { code: await totpCode(welt, userId) },
    headers,
    returnHeaders: true,
  });
  return cookiesAus(bestaetigt);
}

// Legt die Persona mit einem Aufruf an: Konto, Verknüpfungen und Anmeldung
export async function legePersonaAn(
  welt: Welt,
  schluessel: Persona,
): Promise<PersonaKonto> {
  if (schluessel === "ohneLogin") {
    return {
      id: null,
      benutzername: null,
      passwort: null,
      abteilungId: null,
      headers: { "expo-origin": APP, "x-forwarded-for": zufallsIp() },
    };
  }
  const { db, auth } = welt;
  const steckbrief = STECKBRIEFE[schluessel];
  const abteilungId = steckbrief.demo
    ? welt.demoAbteilungId
    : welt.testabteilungId;
  const benutzername = `${steckbrief.benutzername}.${randomUUID().slice(0, 8)}`;
  // Gespeichert wird die normalisierte Form des Startpassworts; angemeldet und zurückgegeben wird die Anzeigeform
  const startpasswort = steckbrief.mussPasswortAendern
    ? erzeugeStartpasswort()
    : null;

  // Ohne Header übergeht createUser die Rechteprüfung; so braucht die Fabrik keinen schon angemeldeten Admin
  const { user } = await auth.api.createUser({
    body: {
      email: `${randomUUID()}@example.org`,
      password: startpasswort
        ? normalisiereStartpasswort(startpasswort)
        : PASSWORT,
      name: steckbrief.name,
      role: steckbrief.admin ? "admin" : "user",
      data: {
        username: benutzername,
        abteilungId,
        // Sonst gilt der Standardwert true, und ohne künftiges Ablaufdatum scheitert jede Anmeldung
        mussPasswortAendern: false,
        // Wie nach einem frisch gesetzten Startpasswort (#18): Flag an, 7 Tage gültig
        ...(startpasswort && startpasswortFelder()),
      },
    },
  });

  const stufen = { A: welt.stufeAId, B: welt.stufeBId };
  for (const [stufe, typ] of steckbrief.rollen ?? []) {
    await db
      .insert(schema.rolle)
      .values({ userId: user.id, stufeId: stufen[stufe], typ });
  }
  const kinder = { A: welt.kindAId, B: welt.kindBId, Demo: welt.demoKindId };
  for (const kind of steckbrief.elternVon ?? []) {
    await db
      .insert(schema.kindEltern)
      .values({ kindId: kinder[kind], userId: user.id });
  }

  // Über auth.api statt auth.handler: Herkunftsprüfung und Rate-Limit laufen nur in dessen Router, und das Budget teilten sich alle Testdateien eines Laufs
  const anmeldung = await auth.api.signInUsername({
    body: { username: benutzername, password: startpasswort ?? PASSWORT },
    returnHeaders: true,
  });
  let cookie = cookiesAus(anmeldung);
  if (steckbrief.zweiterFaktor) {
    cookie = await zweiterFaktorEin(welt, user.id, cookie);
  }
  if (steckbrief.deaktivieren) {
    // Der Zustand, den «Deaktivieren» hinterlässt: gesperrt, Zeitpunkt gesetzt, Sitzungen gelöscht; das abgelaufene Cookie bleibt in den Kopfzeilen
    await db
      .update(schema.user)
      .set({ banned: true, deaktiviertAm: new Date() })
      .where(eq(schema.user.id, user.id));
    await db.delete(schema.session).where(eq(schema.session.userId, user.id));
  }

  return {
    id: user.id,
    benutzername,
    passwort: startpasswort ?? PASSWORT,
    abteilungId,
    headers: { "expo-origin": APP, "x-forwarded-for": zufallsIp(), cookie },
  };
}
