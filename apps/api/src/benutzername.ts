// Eine Regel für beide Prüfstellen: das username-Plugin (auth.ts) und die zod-Schemas der Admin-Routen.
// /i, weil Plugin und Anmeldung die rohe Eingabe prüfen; gespeichert wird kleingeschrieben
export const BENUTZERNAME_MUSTER = /^[a-z0-9._-]+$/i;
export const BENUTZERNAME_MIN = 2;
export const BENUTZERNAME_MAX = 64;
