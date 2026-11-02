import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import { z } from "zod";

// Prüft json, query oder param einer Route; jeder Fehler wird 400 ohne Details von zod
export function eingabe<
  Z extends "json" | "query" | "param",
  S extends z.ZodObject,
>(ziel: Z, schema: S) {
  // Die Typen unterscheiden z.object() und z.strictObject() nicht, darum die Prüfung zur Laufzeit
  if (!(schema.def.catchall instanceof z.ZodNever)) {
    throw new Error(
      "eingabe() braucht ein striktes Schema: z.strictObject() oder .strict()",
    );
  }
  return validator(ziel, (wert: z.input<S>) => {
    const ergebnis = schema.safeParse(wert);
    if (!ergebnis.success) throw new HTTPException(400);
    return ergebnis.data;
  });
}
