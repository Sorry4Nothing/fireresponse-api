import { betterAuth, type BetterAuthOptions } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import {
  admin,
  haveIBeenPwned,
  twoFactor,
  username,
} from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { Hono } from "hono";
import {
  BENUTZERNAME_MAX,
  BENUTZERNAME_MIN,
  BENUTZERNAME_MUSTER,
} from "./benutzername.js";
import { normalisiereStartpasswort } from "./startpasswort.js";

const ac = createAccessControl(defaultStatements);

// Genau die Rechte, die createUser, setUserPassword, revokeUserSessions, banUser, unbanUser und removeUser prüfen; kein impersonate
const rollen = {
  admin: ac.newRole({
    user: ["create", "set-role", "set-password", "ban", "delete"],
    session: ["revoke"],
  }),
  user: ac.newRole({ user: [], session: [] }),
};

// Startpasswort nur bei einer neuen Anmeldung prüfen: change-password und verify-totp in der eigenen laufenden Sitzung legen auch eine Sitzung an und müssen nach dem Ablauf gehen
const anmeldepfade = new Set([
  "/sign-in/username",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

// Felder der Bremse und des Pflichtwechsels am User, wo better-auth nur seinen Grundtyp kennt
type Bremsfelder = {
  mussPasswortAendern?: boolean;
  fehlversuche?: number;
  naechsterVersuchAb?: Date | string | null;
};

// Ab dem 5. Fehlversuch in Folge: 1, dann 5, dann 15 Minuten
export function wartezeitMinuten(fehlversuche: number) {
  if (fehlversuche < 5) return 0;
  return fehlversuche === 5 ? 1 : fehlversuche === 6 ? 5 : 15;
}

// So lang wie die längste Wartezeit: Nach ihr beginnt der Zähler bei 0, darum sperrt ein fremder Fehlversuch alle 15 Minuten das Konto nie
const VERFALL_MINUTEN = 15;

// naechsterVersuchAb ist der letzte Fehlversuch plus seine Wartezeit; ohne Datum gilt 1970, ein ungültiges Datum verfällt nie
export function fehlversucheVerfallen(
  fehlversuche: number,
  naechsterVersuchAb: Date | string | null | undefined,
  jetzt = Date.now(),
) {
  const letzter =
    new Date(naechsterVersuchAb ?? 0).getTime() -
    wartezeitMinuten(fehlversuche) * 60_000;
  return jetzt - letzter >= VERFALL_MINUTEN * 60_000;
}

// Eine Stelle für den Text, den die App kennt: Die Anmeldung und das Löschen des Kontos antworten damit
export const ZU_VIELE_ANFRAGEN = {
  code: "ZU_VIELE_ANFRAGEN",
  message: "Zu viele Anfragen. Bitte später nochmals versuchen.",
} as const;

// shortcut: better-auth verlangt eine eindeutige E-Mail-Adresse; .invalid ist nie zustellbar (RFC 2606). Ersetzen, sobald better-auth Konten ohne E-Mail-Adresse erlaubt
export function platzhalterEmail() {
  return `${crypto.randomUUID()}@benutzer.invalid`;
}

export function erstelleAuth(database: BetterAuthOptions["database"]) {
  return betterAuth({
    database,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      requireEmailVerification: false,
    },
    user: {
      deleteUser: { enabled: true },
      // Wie die Spalten in src/db/schema.ts; better-auth schreibt beim Anlegen seinen defaultValue, darum gleich dem der Datenbank
      additionalFields: {
        abteilungId: { type: "string", input: false, required: true },
        mussPasswortAendern: {
          type: "boolean",
          input: false,
          defaultValue: true,
        },
        startpasswortGueltigBis: {
          type: "date",
          input: false,
          required: false,
        },
        // Nie in Antworten von better-auth
        startpasswortVerschluesselt: {
          type: "string",
          input: false,
          required: false,
          returned: false,
        },
        fehlversuche: { type: "number", input: false, defaultValue: 0 },
        naechsterVersuchAb: { type: "date", input: false, required: false },
        deaktiviertAm: { type: "date", input: false, required: false },
        telefon: { type: "string", input: false, required: false },
        pushProgramme: { type: "boolean", input: false, defaultValue: true },
        pushAnmeldungen: { type: "boolean", input: false, defaultValue: true },
        datenschutzGelesenAm: { type: "date", input: false, required: false },
      },
    },
    session: {
      // 90 Tage, verlängert bei Nutzung (updateAge bleibt beim Standard von 1 Tag); kein cookieCache, damit beendete Sitzungen sofort enden
      expiresIn: 60 * 60 * 24 * 90,
    },
    // Das App-Schema ist eine Baukonstante, darum im Code statt in der Umgebung: Fehlte die Variable, bekäme jeder Cookie-POST der App 403. Das Muster ohne Authority deckt auch fireresponse://<host:port> eines Dev-Builds; better-auth ergänzt BETTER_AUTH_TRUSTED_ORIGINS obendrauf (Tests)
    trustedOrigins: ["fireresponse://"],
    rateLimit: {
      // enabled auch ausserhalb der Produktion; database zählt in rate_limit und übersteht Neustarts
      enabled: true,
      storage: "database",
      // Pfade relativ zu /api/auth, exakter Vergleich; der Zähler beginnt erst neu, wenn das Fenster ohne zugelassene Anfrage verstreicht
      customRules: {
        // 30, damit ein Elternabend im selben WLAN nicht blockiert
        "/sign-in/username": { window: 900, max: 30 },
        "/change-password": { window: 900, max: 5 },
        "/two-factor/verify-totp": { window: 900, max: 5 },
        "/two-factor/verify-backup-code": { window: 900, max: 5 },
      },
    },
    logger: {
      // Eine JSON-Zeile wie src/log.ts, ohne Request-ID (better-auth kennt den Hono-Kontext nicht); args nie: Sie tragen Datenbankfehler mit Zeilen, und logger.error übergibt auch Error-Objekte als Meldung
      log(stufe, meldung) {
        console.log(
          JSON.stringify({
            zeit: new Date().toISOString(),
            quelle: "better-auth",
            stufe,
            meldung:
              typeof meldung === "string"
                ? meldung
                : (meldung as unknown as { name?: string })?.name,
          }),
        );
      },
    },
    advanced: {
      database: { generateId: "uuid" },
      // Sonst prüft better-auth die Herkunft unter NODE_ENV=test nicht
      disableOriginCheck: false,
      // Heute der Standard, aber tragend: Das Rate-Limit zählt nur über den Header, den Caddy kontrolliert (#68)
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    databaseHooks: {
      session: {
        create: {
          async before(sitzung, ctx) {
            if (
              ctx &&
              anmeldepfade.has(ctx.path) &&
              ctx.context.session?.user.id !== sitzung.userId
            ) {
              const person = await ctx.context.adapter.findOne<{
                mussPasswortAendern?: boolean;
                startpasswortGueltigBis?: Date | string | null;
              }>({
                model: "user",
                where: [{ field: "id", value: sitzung.userId }],
              });
              // Im Zweifel sperren: Ohne Datum gilt 1970, und anders als <= sperrt !(… > jetzt) auch ein ungültiges Datum
              if (
                person?.mussPasswortAendern &&
                !(new Date(person.startpasswortGueltigBis ?? 0) > new Date())
              ) {
                throw new APIError("FORBIDDEN", {
                  code: "STARTPASSWORT_ABGELAUFEN",
                  message:
                    "Das Startpasswort ist abgelaufen. Ein Admin kann ein neues setzen.",
                });
              }
            }
            return { data: { ipAddress: null, userAgent: null } };
          },
        },
      },
    },
    hooks: {
      // Vor der Validierung: body kann alles sein, darum die typeof-Prüfungen
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-in/username") {
          if (typeof ctx.body?.username !== "string") return;
          const person = await ctx.context.adapter.findOne<Bremsfelder>({
            model: "user",
            // Das username-Plugin speichert und sucht in Kleinbuchstaben
            where: [
              { field: "username", value: ctx.body.username.toLowerCase() },
            ],
          });
          // Wartezeit ohne Passwortprüfung, ohne Zählen und ohne Verlängern: Sonst könnte jede Person ein fremdes Konto dauerhaft sperren
          if (
            person?.naechsterVersuchAb &&
            new Date(person.naechsterVersuchAb) > new Date()
          ) {
            throw new APIError("UNAUTHORIZED", {
              code: "WARTEZEIT",
              message: "Bitte warten und später nochmals versuchen.",
            });
          }
          if (
            person?.mussPasswortAendern &&
            typeof ctx.body.password === "string"
          ) {
            return {
              context: {
                body: {
                  ...ctx.body,
                  password: normalisiereStartpasswort(ctx.body.password),
                },
              },
            };
          }
          return;
        }
        if (ctx.path === "/two-factor/enable") {
          // Ein Admin mit offenem Startpasswort erreicht enable vor dem Wechsel; der Vergleich bleibt normalisiert
          const sitzung = await getSessionFromCtx(ctx);
          if (
            (sitzung?.user as Bremsfelder | undefined)?.mussPasswortAendern &&
            typeof ctx.body?.password === "string"
          ) {
            return {
              context: {
                body: {
                  ...ctx.body,
                  password: normalisiereStartpasswort(ctx.body.password),
                },
              },
            };
          }
          return;
        }
        if (
          ctx.path === "/two-factor/verify-totp" ||
          ctx.path === "/two-factor/verify-backup-code"
        ) {
          // Kein «Gerät vertrauen»: Auf jedem neuen Gerät fragt der Login nach dem Code, was der Client auch schickt
          return { context: { body: { ...ctx.body, trustDevice: false } } };
        }
        if (ctx.path !== "/change-password") return;
        const sitzung = await getSessionFromCtx(ctx);
        const offen =
          (sitzung?.user as Bremsfelder | undefined)?.mussPasswortAendern ===
          true;
        const body = { ...ctx.body, revokeOtherSessions: true };
        if (offen && typeof body.currentPassword === "string") {
          body.currentPassword = normalisiereStartpasswort(
            body.currentPassword,
          );
        }
        if (
          typeof body.newPassword === "string" &&
          (offen
            ? normalisiereStartpasswort(body.newPassword)
            : body.newPassword) === body.currentPassword
        ) {
          throw new APIError("BAD_REQUEST", {
            code: "PASSWORT_UNVERAENDERT",
            message:
              "Das neue Passwort muss sich vom bisherigen unterscheiden.",
          });
        }
        return { context: { body } };
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-in/username") {
          const { adapter, newSession, returned } = ctx.context;
          if (newSession) {
            // Dieser Hook läuft vor dem des twoFactor-Plugins, die neue Sitzung ist also auch bei dessen Umleitung noch da
            const person = newSession.user as Bremsfelder & { id: string };
            if (person.fehlversuche || person.naechsterVersuchAb) {
              await adapter.update({
                model: "user",
                where: [{ field: "id", value: person.id }],
                update: { fehlversuche: 0, naechsterVersuchAb: null },
              });
            }
            return;
          }
          // Nur echte Fehlversuche zählen: Ablauf (403), Sperre (403) und Formatfehler (422) nicht
          if (
            !isAPIError(returned) ||
            returned.body?.code !== "INVALID_USERNAME_OR_PASSWORD" ||
            typeof ctx.body?.username !== "string"
          ) {
            return;
          }
          const person = await adapter.findOne<Bremsfelder & { id: string }>({
            model: "user",
            where: [
              { field: "username", value: ctx.body.username.toLowerCase() },
            ],
          });
          // Unbekannte Namen hinterlassen nichts
          if (!person) return;
          const wo = [{ field: "id", value: person.id }];
          if (
            person.fehlversuche &&
            fehlversucheVerfallen(
              person.fehlversuche,
              person.naechsterVersuchAb,
            )
          ) {
            // Nur auf den gelesenen Stand: Von gleichzeitigen Fehlversuchen setzt einer zurück, die übrigen zählen weiter
            await adapter.update({
              model: "user",
              where: [
                ...wo,
                { field: "fehlversuche", value: person.fehlversuche },
              ],
              update: { fehlversuche: 0 },
            });
          }
          const erhoeht = await adapter.incrementOne<{ fehlversuche: number }>({
            model: "user",
            where: wo,
            increment: { fehlversuche: 1 },
          });
          const minuten = wartezeitMinuten(erhoeht?.fehlversuche ?? 0);
          // Auch ohne Wartezeit: Daraus liest fehlversucheVerfallen den letzten Fehlversuch
          await adapter.update({
            model: "user",
            where: wo,
            update: {
              naechsterVersuchAb: new Date(Date.now() + minuten * 60_000),
            },
          });
          return;
        }
        if (ctx.path === "/two-factor/enable") {
          const { returned, session } = ctx.context;
          const link = (returned as { totpURI?: unknown } | undefined)?.totpURI;
          const benutzername = (session?.user as { username?: string })
            ?.username;
          if (isAPIError(returned) || typeof link !== "string") return;
          const schluessel = new URL(link).searchParams.get("secret");
          if (!schluessel || !benutzername) return;
          // better-auth schriebe die Platzhalter-E-Mail-Adresse in den Link; Apps zeigen daran den Eintrag. Format wie dort: Leerzeichen als %20, 6 Stellen, 30 s
          const name = encodeURIComponent("FireResponse");
          return ctx.json({
            ...(returned as object),
            totpURI: `otpauth://totp/${name}:${encodeURIComponent(benutzername)}?secret=${schluessel}&issuer=${name}&digits=6&period=30`,
          });
        }
        if (ctx.path === "/two-factor/verify-totp") {
          const { newSession, session } = ctx.context;
          const vorher = session?.user as { twoFactorEnabled?: boolean };
          // Nur der Schritt, der den Faktor einschaltet (in der Anmeldung gibt es noch keine Sitzung): Andere Sitzungen kamen ohne Code zustande und enden hier
          if (
            session &&
            newSession &&
            vorher.twoFactorEnabled !== true &&
            (newSession.user as { twoFactorEnabled?: boolean })
              .twoFactorEnabled === true
          ) {
            await ctx.context.adapter.deleteMany({
              model: "session",
              where: [
                { field: "userId", value: newSession.user.id },
                {
                  field: "token",
                  operator: "ne",
                  value: newSession.session.token,
                },
              ],
            });
          }
          return;
        }
        if (
          ctx.path !== "/change-password" ||
          isAPIError(ctx.context.returned) ||
          !ctx.context.session
        ) {
          return;
        }
        await ctx.context.internalAdapter.updateUser(
          ctx.context.session.user.id,
          { mussPasswortAendern: false, startpasswortVerschluesselt: null },
        );
      }),
    },
    plugins: [
      // Der Standard verböte den Bindestrich und mehr als 30 Zeichen; geprüft wird die rohe Eingabe, gespeichert kleingeschrieben
      username({
        usernameValidator: (benutzername) =>
          BENUTZERNAME_MUSTER.test(benutzername),
        minUsernameLength: BENUTZERNAME_MIN,
        maxUsernameLength: BENUTZERNAME_MAX,
      }),
      admin({ ac, roles: rollen }),
      // Name wie in app.json; sonst die Standards: 6 Stellen, 30 s, zehn Ersatzcodes
      twoFactor({ issuer: "FireResponse" }),
      haveIBeenPwned(),
    ],
  });
}

// Alles andere unter /api/auth liefert 404, auch update-user, sign-in/email, sign-up/email, is-username-available und admin/*
export const offenePfade = [
  "POST /api/auth/sign-in/username",
  "POST /api/auth/sign-out",
  "GET /api/auth/get-session",
  "POST /api/auth/change-password",
  "POST /api/auth/revoke-sessions",
  "POST /api/auth/two-factor/verify-totp",
  "POST /api/auth/two-factor/verify-backup-code",
  "POST /api/auth/two-factor/enable",
] as const;

// Ersetzt das Server-Plugin von @better-auth/expo: Der Expo-Client meldet seine Herkunft in expo-origin
function mitExpoOrigin(anfrage: Request) {
  const expoOrigin = anfrage.headers.get("expo-origin");
  if (!expoOrigin || anfrage.headers.has("origin")) return anfrage;
  const kopfzeilen = new Headers(anfrage.headers);
  kopfzeilen.set("origin", expoOrigin);
  return new Request(anfrage, { headers: kopfzeilen });
}

export function erstelleAuthRouten(auth: ReturnType<typeof erstelleAuth>) {
  const routen = new Hono();
  // Den zweiten Faktor richten nur Admins ein; für alle anderen ist der Pfad zu
  routen.post("/api/auth/two-factor/enable", async (c, next) => {
    const sitzung = await auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableRefresh: true },
    });
    if (sitzung?.user.role !== "admin") return c.notFound();
    await next();
  });
  for (const eintrag of offenePfade) {
    const [methode, pfad] = eintrag.split(" ");
    const anmeldung = eintrag === "POST /api/auth/sign-in/username";
    // Beide Umbauten hier statt in einem after-Hook: dispatchAuthEndpoint behielte dessen Status und verriete den Fall
    routen.on(methode, pfad, async (c) => {
      const antwort = await auth.handler(mitExpoOrigin(c.req.raw));
      // better-auth antwortet auf 429 nur mit einer englischen message; X-Retry-After bleibt
      if (antwort.status === 429) {
        return c.json(ZU_VIELE_ANFRAGEN, 429, {
          "X-Retry-After": antwort.headers.get("X-Retry-After") ?? "",
        });
      }
      // Jeder Fehler bei der Anmeldung zeigt dieselbe Meldung: falsches Passwort, Wartezeit, abgelaufenes Startpasswort, deaktiviert, ungültiger Name
      if (anmeldung && antwort.status >= 400 && antwort.status < 500) {
        return c.json(
          {
            code: "ANMELDUNG_FEHLGESCHLAGEN",
            message:
              "Anmeldung nicht möglich. Bitte Benutzername und Passwort prüfen oder später nochmals versuchen. Sonst hilft ein Admin.",
          },
          401,
        );
      }
      return antwort;
    });
  }
  return routen;
}
