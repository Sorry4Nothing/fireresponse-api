import { randomUUID } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";
import { EINWILLIGUNG_VERSION } from "../../src/einwilligung.js";
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

// Die Personas der Rechte-Matrix, in der Reihenfolge des Matrix-Tests
export const PERSONAS = [
  "kantonsadmin",
  "kantonsadminOhneZweitenFaktor",
  "kommandoJfA",
  "kommandoKfBOhneZweitenFaktor",
  "stellvertretung1JfA",
  "stellvertretung2JfA",
  "kommandoKfA",
  "kommandoJfB",
  "leitendeJfA",
  "leitendeJfAElternKfA",
  "elternJfA",
  "elternAundB",
  "elternKfA",
  "teilnehmendeSelbstJfA",
  "elternNachWechsel",
  "ohneEinwilligung",
  "mussPasswortAendern",
  "deaktiviert",
  "ohneLogin",
] as const;

export type Persona = (typeof PERSONAS)[number];

type TestAuth = ReturnType<typeof erstelleTestAuth>;

export type EinheitKey = "jfA" | "kfA" | "jfB" | "kfB";
export type TeilnehmendeKey = "jfA" | "jfA2" | "jfAWechsel" | "kfA" | "jfB";

export interface Welt {
  db: Db;
  auth: TestAuth;
  bezirkAId: string;
  bezirkBId: string;
  einheit: Record<EinheitKey, string>;
  teilnehmende: Record<TeilnehmendeKey, string>;
  rangId: string;
}

// Eine Welt pro Testdatei: Die Dateien laufen parallel und teilen sich so keine Zeilen
export async function erstelleWelt(db: Db, auth: TestAuth): Promise<Welt> {
  const suffix = randomUUID().slice(0, 8);
  const [bezirkA] = await db
    .insert(schema.bezirk)
    .values({ name: `Bezirk A ${suffix}` })
    .returning();
  const [bezirkB] = await db
    .insert(schema.bezirk)
    .values({ name: `Bezirk B ${suffix}` })
    .returning();
  const einheit = async (bezirkId: string, typ: "jf" | "kf", name: string) =>
    (
      await db
        .insert(schema.einheit)
        .values({ bezirkId, typ, name })
        .returning({ id: schema.einheit.id })
    )[0].id;
  const e = {
    jfA: await einheit(bezirkA.id, "jf", "JF A"),
    kfA: await einheit(bezirkA.id, "kf", "KF A"),
    jfB: await einheit(bezirkB.id, "jf", "JF B"),
    kfB: await einheit(bezirkB.id, "kf", "KF B"),
  };
  const [rang] = await db
    .insert(schema.rang)
    .values({
      einheitId: e.jfA,
      name: "Rang Eins",
      kuerzel: "R1",
      reihenfolge: 1,
      abzeichenSterne: 1,
    })
    .returning({ id: schema.rang.id });

  const teilnehmende = async (einheitId: string, nachname: string) =>
    (
      await db
        .insert(schema.teilnehmende)
        .values({ einheitId, vorname: "Person", nachname })
        .returning({ id: schema.teilnehmende.id })
    )[0].id;
  return {
    db,
    auth,
    bezirkAId: bezirkA.id,
    bezirkBId: bezirkB.id,
    einheit: e,
    teilnehmende: {
      jfA: await teilnehmende(e.jfA, "JfA"),
      jfA2: await teilnehmende(e.jfA, "JfA2"),
      jfAWechsel: await teilnehmende(e.jfA, "JfAWechsel"),
      kfA: await teilnehmende(e.kfA, "KfA"),
      jfB: await teilnehmende(e.jfB, "JfB"),
    },
    rangId: rang.id,
  };
}

export interface PersonaKonto {
  id: string | null;
  benutzername: string | null;
  passwort: string | null;
  // Kopfzeilen wie vom Expo-Client: Herkunft im App-Schema und das gespeicherte Cookie
  headers: Record<string, string>;
}

type Rolle = readonly [
  EinheitKey,
  "kommandant" | "stellvertretung" | "leitung",
  number?,
];

interface Steckbrief {
  name: string;
  benutzername: string;
  admin?: true;
  zweiterFaktor?: true;
  rollen?: readonly Rolle[];
  // Teilnehmende, für die das Konto antwortet: Eltern oder die Person selbst
  konten?: readonly (readonly [TeilnehmendeKey, "eltern" | "selbst"])[];
  mussPasswortAendern?: true;
  ohneEinwilligung?: true;
  deaktivieren?: true;
}

const STECKBRIEFE: Record<Exclude<Persona, "ohneLogin">, Steckbrief> = {
  kantonsadmin: {
    name: "Kantonsadmin",
    benutzername: "kantonsadmin",
    admin: true,
    zweiterFaktor: true,
  },
  kantonsadminOhneZweitenFaktor: {
    name: "Kantonsadmin ohne zweiten Faktor",
    benutzername: "kantonsadmin.ohne",
    admin: true,
  },
  kommandoJfA: {
    name: "Kommando JF A",
    benutzername: "kommando.jf.a",
    rollen: [["jfA", "kommandant"]],
    zweiterFaktor: true,
  },
  // Der Zugang des Kommandos über die App: keine Sitzung mit zweitem Faktor
  kommandoKfBOhneZweitenFaktor: {
    name: "Kommando KF B in der App",
    benutzername: "kommando.kf.b.app",
    rollen: [["kfB", "kommandant"]],
  },
  stellvertretung1JfA: {
    name: "Stellvertretung 1 JF A",
    benutzername: "stv1.jf.a",
    rollen: [["jfA", "stellvertretung", 1]],
    zweiterFaktor: true,
  },
  stellvertretung2JfA: {
    name: "Stellvertretung 2 JF A",
    benutzername: "stv2.jf.a",
    rollen: [["jfA", "stellvertretung", 2]],
    zweiterFaktor: true,
  },
  kommandoKfA: {
    name: "Kommando KF A",
    benutzername: "kommando.kf.a",
    rollen: [["kfA", "kommandant"]],
    zweiterFaktor: true,
  },
  kommandoJfB: {
    name: "Kommando JF B",
    benutzername: "kommando.jf.b",
    rollen: [["jfB", "kommandant"]],
    zweiterFaktor: true,
  },
  leitendeJfA: {
    name: "Leitende JF A",
    benutzername: "leitende.jf.a",
    rollen: [["jfA", "leitung"]],
  },
  leitendeJfAElternKfA: {
    name: "Leitende JF A und zugleich Elternteil KF A",
    benutzername: "leitende.jf.a.eltern.kf.a",
    rollen: [["jfA", "leitung"]],
    konten: [["kfA", "eltern"]],
  },
  elternJfA: {
    name: "Eltern JF A",
    benutzername: "eltern.jf.a",
    konten: [["jfA", "eltern"]],
  },
  elternAundB: {
    name: "Eltern mit Kindern in zwei Bezirken",
    benutzername: "eltern.a.und.b",
    konten: [
      ["jfA", "eltern"],
      ["jfB", "eltern"],
    ],
  },
  elternKfA: {
    name: "Eltern KF A",
    benutzername: "eltern.kf.a",
    konten: [["kfA", "eltern"]],
  },
  teilnehmendeSelbstJfA: {
    name: "Teilnehmende JF A mit eigenem Konto",
    benutzername: "selbst.jf.a",
    konten: [["jfAWechsel", "selbst"]],
  },
  // Das Kind jfAWechsel hat ein eigenes Konto; diese Eltern behalten ein zweites Kind und haben den Zugriff auf das erste verloren
  elternNachWechsel: {
    name: "Eltern nach dem Wechsel aufs Kind-Konto",
    benutzername: "eltern.nach.wechsel",
    konten: [["jfA2", "eltern"]],
  },
  ohneEinwilligung: {
    name: "Ohne Einwilligung",
    benutzername: "ohne.einwilligung",
    konten: [["jfA", "eltern"]],
    ohneEinwilligung: true,
  },
  mussPasswortAendern: {
    name: "Muss Passwort ändern",
    benutzername: "muss.wechseln",
    konten: [["jfA", "eltern"]],
    mussPasswortAendern: true,
  },
  deaktiviert: {
    name: "Deaktiviert",
    benutzername: "deaktiviert",
    konten: [["jfA", "eltern"]],
    deaktivieren: true,
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
      headers: { "expo-origin": APP, "x-forwarded-for": zufallsIp() },
    };
  }
  const { db, auth } = welt;
  const steckbrief = STECKBRIEFE[schluessel];
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
        // Sonst gilt der Standardwert true, und ohne künftiges Ablaufdatum scheitert jede Anmeldung
        mussPasswortAendern: false,
        ...(!steckbrief.ohneEinwilligung && {
          einwilligungAm: new Date(),
          einwilligungVersion: EINWILLIGUNG_VERSION,
        }),
        // Wie nach einem frisch gesetzten Startpasswort (#18): Flag an, 7 Tage gültig
        ...(startpasswort && startpasswortFelder()),
      },
    },
  });

  for (const [einheit, typ, reihenfolge] of steckbrief.rollen ?? []) {
    // Kommandant und Position der Stellvertretung gibt es je Einheit nur einmal: Eine neue Persona löst die frühere derselben Rolle ab, wie eine Übergabe. Wer mehrere Personas derselben Rolle braucht, legt eine eigene Welt an
    if (typ === "kommandant" || typ === "stellvertretung") {
      await db
        .delete(schema.einheitRolle)
        .where(
          and(
            eq(schema.einheitRolle.einheitId, welt.einheit[einheit]),
            typ === "kommandant"
              ? eq(schema.einheitRolle.typ, "kommandant")
              : eq(schema.einheitRolle.reihenfolge, reihenfolge!),
          ),
        );
    }
    await db.insert(schema.einheitRolle).values({
      userId: user.id,
      einheitId: welt.einheit[einheit],
      typ,
      reihenfolge: reihenfolge ?? null,
    });
  }
  for (const [teilnehmende, art] of steckbrief.konten ?? []) {
    // Höchstens ein eigenes Konto je Person: Eine neue Persona löst das frühere ab
    if (art === "selbst") {
      await db
        .delete(schema.teilnehmendeKonto)
        .where(
          and(
            eq(
              schema.teilnehmendeKonto.teilnehmendeId,
              welt.teilnehmende[teilnehmende],
            ),
            eq(schema.teilnehmendeKonto.art, "selbst"),
          ),
        );
    }
    await db.insert(schema.teilnehmendeKonto).values({
      userId: user.id,
      teilnehmendeId: welt.teilnehmende[teilnehmende],
      art,
    });
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
    headers: { "expo-origin": APP, "x-forwarded-for": zufallsIp(), cookie },
  };
}
