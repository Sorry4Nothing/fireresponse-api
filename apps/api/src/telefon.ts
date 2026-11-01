import { z } from "zod";

// Freiwillig, nur SL; leer oder null entfernt die Nummer. Nur Ziffern und die üblichen Trennzeichen, damit der Wert in «tel:» taugt
export const telefonSchema = z
  .string()
  .trim()
  .transform((wert) => wert || null)
  .refine((wert) => wert === null || /^\+?\d[\d ()/.-]{4,28}\d$/.test(wert))
  .nullable();
