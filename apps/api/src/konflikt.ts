// Eigene 409-Codes mit eigener Antwort: onError machte aus einer HTTPException(409) nur «FEHLER»
export const KONFLIKT = {
  BENUTZERNAME_VERGEBEN: {
    code: "BENUTZERNAME_VERGEBEN",
    message: "Dieser Benutzername ist schon vergeben.",
  },
  BEZIRK_VORHANDEN: {
    code: "BEZIRK_VORHANDEN",
    message: "Einen Bezirk mit diesem Namen gibt es schon.",
  },
  BEZIRK_BELEGT: {
    code: "BEZIRK_BELEGT",
    message: "Der Bezirk hat noch Einheiten und lässt sich nicht löschen.",
  },
  EINHEIT_VORHANDEN: {
    code: "EINHEIT_VORHANDEN",
    message: "Dieser Bezirk hat schon eine Einheit dieser Art.",
  },
  REIHENFOLGE_BELEGT: {
    code: "REIHENFOLGE_BELEGT",
    message: "Diese Position der Stellvertretung ist schon besetzt.",
  },
  ELTERN_ANTWORTEN: {
    code: "ELTERN_ANTWORTEN",
    message:
      "Für diese Person antworten die Eltern. Den Wechsel aufs eigene Konto macht der Konto-Wechsel.",
  },
  SELBST_ANTWORTET: {
    code: "SELBST_ANTWORTET",
    message: "Diese Person antwortet selbst, Eltern kommen nicht dazu.",
  },
  EIGENES_KONTO_VORHANDEN: {
    code: "EIGENES_KONTO_VORHANDEN",
    message: "Diese Person hat schon ein eigenes Konto.",
  },
  SCHON_VERKNUEPFT: {
    code: "SCHON_VERKNUEPFT",
    message: "Dieses Konto antwortet schon für diese Person.",
  },
  EIGENES_KONTO: {
    code: "EIGENES_KONTO",
    message:
      "Das eigene Konto lässt sich hier nicht zurücksetzen oder deaktivieren.",
  },
  KONTO_GEMEINSAM: {
    code: "KONTO_GEMEINSAM",
    message:
      "Dieses Konto gehört auch zu einer anderen Einheit. Nur der Kantonsadmin ändert es.",
  },
  KEIN_ZWEITER_FAKTOR: {
    code: "KEIN_ZWEITER_FAKTOR",
    message: "Diese Person hat keinen zweiten Faktor.",
  },
  KEIN_STARTPASSWORT: {
    code: "KEIN_STARTPASSWORT",
    message: "Es ist kein Startpasswort mehr offen.",
  },
  RANG_REIHENFOLGE_BELEGT: {
    code: "RANG_REIHENFOLGE_BELEGT",
    message: "Diese Reihenfolge hat in der Einheit schon ein anderer Rang.",
  },
  RAENGE_VOLL: {
    code: "RAENGE_VOLL",
    message: "Eine Einheit hat höchstens 99 Ränge.",
  },
  RANG_IN_VERWENDUNG: {
    code: "RANG_IN_VERWENDUNG",
    message:
      "Dieser Rang ist noch zugeteilt. Wähle einen Rang, in den die Personen wechseln.",
  },
} as const;

// Trägt einen Konflikt aus einer Transaktion heraus: Sie rollt zurück, app.ts antwortet 409
export class Konflikt extends Error {
  constructor(public konflikt: keyof typeof KONFLIKT) {
    super(KONFLIKT[konflikt].message);
  }
}

// Drizzle verpackt den Fehler von postgres-js in cause; 23505 = Verstoss gegen einen UNIQUE-Index
export function eindeutigkeitsVerstoss(fehler: unknown): string | undefined {
  for (let f = fehler as Record<string, unknown> | undefined; f;) {
    if (f.code === "23505") return String(f.constraint_name ?? "");
    f = f.cause as Record<string, unknown> | undefined;
  }
  return undefined;
}
