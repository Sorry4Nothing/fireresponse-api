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
  username: expect.any(String),
  email: expect.stringMatching(/@example\.org$/),
  role: "user",
  muss_passwort_aendern: false,
  startpasswort_gueltig_bis: null,
  banned: false,
  deaktiviert_am: null,
  two_factor_enabled: false,
  einwilligung_version: 1,
  rollen: [],
  teilnehmende: [],
};

// Unabhängig von der Fabrik: Rollen und verknüpfte Teilnehmende mit Namen statt IDs
const ERWARTET: Record<Persona, object | null> = {
  kantonsadmin: { role: "admin", two_factor_enabled: true },
  kantonsadminOhneZweitenFaktor: { role: "admin" },
  kommandoJfA: { rollen: ["kommandant in JF A"], two_factor_enabled: true },
  kommandoKfBOhneZweitenFaktor: { rollen: ["kommandant in KF B"] },
  stellvertretung1JfA: {
    rollen: ["stellvertretung in JF A"],
    two_factor_enabled: true,
  },
  stellvertretung2JfA: {
    rollen: ["stellvertretung in JF A"],
    two_factor_enabled: true,
  },
  kommandoKfA: { rollen: ["kommandant in KF A"], two_factor_enabled: true },
  kommandoJfB: { rollen: ["kommandant in JF B"], two_factor_enabled: true },
  leitendeJfA: { rollen: ["leitung in JF A"] },
  leitendeJfAElternKfA: {
    rollen: ["leitung in JF A"],
    teilnehmende: ["eltern von Person KfA in KF A"],
  },
  elternJfA: { teilnehmende: ["eltern von Person JfA in JF A"] },
  elternAundB: {
    teilnehmende: [
      "eltern von Person JfA in JF A",
      "eltern von Person JfB in JF B",
    ],
  },
  elternKfA: { teilnehmende: ["eltern von Person KfA in KF A"] },
  teilnehmendeSelbstJfA: {
    teilnehmende: ["selbst von Person JfAWechsel in JF A"],
  },
  elternNachWechsel: { teilnehmende: ["eltern von Person JfA2 in JF A"] },
  ohneEinwilligung: {
    teilnehmende: ["eltern von Person JfA in JF A"],
    einwilligung_version: null,
  },
  mussPasswortAendern: {
    teilnehmende: ["eltern von Person JfA in JF A"],
    muss_passwort_aendern: true,
    startpasswort_gueltig_bis: expect.any(Date),
  },
  deaktiviert: {
    teilnehmende: ["eltern von Person JfA in JF A"],
    banned: true,
    deaktiviert_am: expect.any(Date),
  },
  ohneLogin: null,
};

test.each(PERSONAS)(
  "%s lässt sich mit einem Aufruf anlegen",
  async (schluessel) => {
    const persona = await legePersonaAn(welt, schluessel);

    const [zeile = null] = await sql`
    select u.username, u.email, u.role, u.einwilligung_version,
      u.muss_passwort_aendern, u.startpasswort_gueltig_bis, u.banned, u.deaktiviert_am, u.two_factor_enabled,
      array(
        select r.typ || ' in ' || e.name from einheit_rolle r join einheit e on e.id = r.einheit_id
        where r.user_id = u.id
      ) as rollen,
      array(
        select k.art || ' von ' || t.vorname || ' ' || t.nachname || ' in ' || e.name
        from teilnehmende_konto k join teilnehmende t on t.id = k.teilnehmende_id join einheit e on e.id = t.einheit_id
        where k.user_id = u.id order by t.nachname
      ) as teilnehmende
    from "user" u
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
