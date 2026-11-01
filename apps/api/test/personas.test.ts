import postgres from "postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { erstelleDb } from "../src/db/client.js";
import {
  APP,
  PASSWORT,
  bereiteAuthTestsVor,
  erstelleTestAuth,
} from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  PERSONAS,
  erstelleWelt,
  legePersonaAn,
  type Persona,
  type Welt,
} from "./hilfen/personas.js";

bereiteAuthTestsVor();

const sql = postgres(API_URL);
// Eigener Client für Drizzle: drizzle() liefert Zeitpunkte seines Clients danach als Text
const db = erstelleDb(postgres(API_URL));
const auth = erstelleTestAuth(db);

let welt: Welt;
beforeAll(async () => {
  welt = await erstelleWelt(db, auth);
});
afterAll(() => Promise.all([sql.end(), db.$client.end()]));

const GRUND = {
  abteilung_id: expect.any(String),
  username: expect.any(String),
  email: expect.stringMatching(/@example\.org$/),
  role: "user",
  muss_passwort_aendern: false,
  startpasswort_gueltig_bis: null,
  banned: false,
  deaktiviert_am: null,
  two_factor_enabled: false,
  rollen: [],
  kinder: [],
};
const TEST = { abteilung: "Testabteilung" };
// Wie die Review-Konten beginnen die Benutzernamen der Demo-Abteilung mit «demo.»
const DEMO = {
  abteilung: "Demo-Abteilung",
  username: expect.stringMatching(/^demo\./),
};

// Unabhängig von der Fabrik: Rollen und Kinder nur aus der Abteilung der Person, mit Namen statt IDs
const ERWARTET: Record<Persona, object | null> = {
  admin: { ...TEST, role: "admin", two_factor_enabled: true },
  adminOhneZweitenFaktor: { ...TEST, role: "admin" },
  slA: { ...TEST, rollen: ["stufenleitung in Stufe A"] },
  slB: { ...TEST, rollen: ["stufenleitung in Stufe B"] },
  leitendeA: { ...TEST, rollen: ["leitung in Stufe A"] },
  leitendeB: { ...TEST, rollen: ["leitung in Stufe B"] },
  leitendeAElternB: {
    ...TEST,
    rollen: ["leitung in Stufe A"],
    kinder: ["Kind B in Stufe B"],
  },
  elternA: { ...TEST, kinder: ["Kind A in Stufe A"] },
  elternB: { ...TEST, kinder: ["Kind B in Stufe B"] },
  mussPasswortAendern: {
    ...TEST,
    kinder: ["Kind A in Stufe A"],
    muss_passwort_aendern: true,
    startpasswort_gueltig_bis: expect.any(Date),
  },
  deaktiviert: {
    ...TEST,
    kinder: ["Kind A in Stufe A"],
    banned: true,
    deaktiviert_am: expect.any(Date),
  },
  ohneLogin: null,
  demoAdmin: { ...DEMO, role: "admin", two_factor_enabled: true },
  demoEltern: { ...DEMO, kinder: ["Kind Demo in Demo-Stufe"] },
};

test.each(PERSONAS)(
  "%s lässt sich mit einem Aufruf anlegen",
  async (schluessel) => {
    const persona = await legePersonaAn(welt, schluessel);

    const [zeile = null] = await sql`
    select a.name as abteilung, u.abteilung_id, u.username, u.email, u.role,
      u.muss_passwort_aendern, u.startpasswort_gueltig_bis, u.banned, u.deaktiviert_am, u.two_factor_enabled,
      array(
        select r.typ || ' in ' || s.name from rolle r join stufe s on s.id = r.stufe_id
        where r.user_id = u.id and s.abteilung_id = u.abteilung_id
      ) as rollen,
      array(
        select k.vorname || ' ' || k.nachname || ' in ' || s.name
        from kind_eltern ke join kind k on k.id = ke.kind_id join stufe s on s.id = k.stufe_id
        where ke.user_id = u.id and k.abteilung_id = u.abteilung_id and s.abteilung_id = u.abteilung_id
      ) as kinder
    from "user" u join abteilung a on a.id = u.abteilung_id
    where u.id = ${persona.id}`;
    const erwartet = ERWARTET[schluessel];
    expect(zeile).toEqual(erwartet && { ...GRUND, ...erwartet });

    // Für «muss Passwort ändern» die Anzeigeform des Startpassworts, gespeichert ist die normalisierte
    const start =
      /^[2-9ACDEFGHJKMNPQRTUVWXY]{4}-[2-9ACDEFGHJKMNPQRTUVWXY]{4}-[2-9ACDEFGHJKMNPQRTUVWXY]{4}$/;
    const ip = /^2001:0db8:[0-9a-f]{4}:[0-9a-f]{4}:0000:0000:0000:0000$/;
    expect(persona).toEqual({
      id: zeile ? persona.id : null,
      benutzername: zeile?.username ?? null,
      passwort: zeile
        ? schluessel === "mussPasswortAendern"
          ? expect.stringMatching(start)
          : PASSWORT
        : null,
      abteilungId: zeile?.abteilung_id ?? null,
      headers: zeile
        ? {
            "expo-origin": APP,
            "x-forwarded-for": expect.stringMatching(ip),
            cookie: expect.stringMatching(
              /^__Secure-better-auth\.session_token=[^;]+$/,
            ),
          }
        : {
            "expo-origin": APP,
            "x-forwarded-for": expect.stringMatching(ip),
          },
    });

    // Die deaktivierte Person behält nur ihr veraltetes Cookie
    const sitzung = await auth.api.getSession({ headers: persona.headers });
    expect(sitzung?.user.id ?? null).toBe(
      schluessel === "deaktiviert" ? null : persona.id,
    );
  },
);
