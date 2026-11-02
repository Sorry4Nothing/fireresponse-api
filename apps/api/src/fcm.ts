import { cert, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import type { Fcm } from "./push.js";

// Liest den Schlüssel des Firebase-Dienstkontos aus der Datei; ein Fehler beim Lesen beendet den Start wie eine ungültige Variable
export function erstelleFcm(schluesselDatei: string): Fcm {
  return getMessaging(initializeApp({ credential: cert(schluesselDatei) }));
}
