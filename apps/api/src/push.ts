import { inArray } from "drizzle-orm";
import type { TokenMessage } from "firebase-admin/messaging";
import type { Context } from "hono";
import type { Db } from "./db/client.js";
import { pushToken } from "./db/schema.js";
import { log } from "./log.js";

// Der Text steht unter dem Titel. Er trägt nie Inhalte oder Namen von Kindern: Der Push steht je nach Handy auf dem gesperrten Bildschirm
export type Push = {
  typ: "programm";
  id: string;
  titel: string;
  text?: string;
};

// Was sendePush vom Messaging-Dienst von firebase-admin braucht; im Test eine Attrappe
export type Fcm = {
  sendEach(nachrichten: TokenMessage[]): Promise<{
    responses: { success: boolean; error?: { code?: string } }[];
  }>;
};

// sendEach nimmt höchstens 500 Nachrichten
const BLOCK = 500;

// Diese Codes meldet FCM, wenn das Token nicht mehr gilt (App deinstalliert, Token erneuert)
const ABGEMELDET = [
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
];

const KANAL = {
  programm: "programme",
};

type Fehler = { code?: unknown; cause?: { code?: unknown } };

// Nur der Code: message enthält das Token, Drizzles message die SQL-Parameter
function meldeFehler(c: Context | undefined, fehler: unknown) {
  const f = (fehler ?? {}) as Fehler;
  const code = f.code ?? f.cause?.code;
  log(c, {
    ereignis: "push",
    code: typeof code === "string" ? code : undefined,
  });
}

// Wirft nie: Aufrufer pushen nach dem Speichern ihrer Änderung, ein Fehler hier darf sie nicht wiederholen lassen
// Ohne Fcm (kein Schlüssel des Dienstkontos) geht nichts hinaus
export async function sendePush(
  { db, fcm, c }: { db: Db; fcm?: Fcm; c?: Context },
  empfaenger: string[],
  { typ, id, titel, text }: Push,
): Promise<void> {
  if (!fcm) return;
  const kanal = KANAL[typ];
  let tokens: string[];
  try {
    const zeilen = await db
      .select({ token: pushToken.token })
      .from(pushToken)
      .where(inArray(pushToken.userId, empfaenger));
    tokens = zeilen.map(({ token }) => token);
  } catch (fehler) {
    meldeFehler(c, fehler);
    return;
  }

  const abgemeldet: string[] = [];
  for (let i = 0; i < tokens.length; i += BLOCK) {
    const block = tokens.slice(i, i + BLOCK);
    try {
      const { responses } = await fcm.sendEach(
        block.map((token): TokenMessage => ({
          token,
          notification: { title: titel, ...(text && { body: text }) },
          data: { typ, id },
          android: {
            priority: "high",
            notification: {
              sound: "default",
              channelId: kanal,
            },
          },
          apns: { payload: { aps: { sound: "default" } } },
        })),
      );
      responses.forEach((antwort, j) => {
        if (antwort.success) return;
        meldeFehler(c, antwort.error);
        if (ABGEMELDET.includes(antwort.error?.code ?? ""))
          abgemeldet.push(block[j]!);
      });
    } catch (fehler) {
      meldeFehler(c, fehler);
    }
  }

  if (abgemeldet.length === 0) return;
  try {
    await db.delete(pushToken).where(inArray(pushToken.token, abgemeldet));
  } catch (fehler) {
    meldeFehler(c, fehler);
  }
}
