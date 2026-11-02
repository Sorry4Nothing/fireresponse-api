import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

// Ohne 0, O, 1, I, L und ohne B, S, Z (ähneln 8, 5, 2): Startpasswörter werden vorgelesen und abgetippt
const ZEICHEN = "23456789ACDEFGHJKMNPQRTUVWXY";
const LAENGE = 12;
const TAG = 86_400_000;

// 12 Zeichen aus 28 ergeben rund 58 Bit; Verwerfen ab 252 (grösstes Vielfaches von 28 unter 256) hält die Ziehung gleichmässig
export function erzeugeStartpasswort() {
  const zeichen: string[] = [];
  while (zeichen.length < LAENGE) {
    for (const byte of crypto.getRandomValues(new Uint8Array(LAENGE))) {
      if (byte >= 252 || zeichen.length === LAENGE) continue;
      zeichen.push(ZEICHEN[byte % ZEICHEN.length]);
    }
  }
  return [zeichen.slice(0, 4), zeichen.slice(4, 8), zeichen.slice(8)]
    .map((gruppe) => gruppe.join(""))
    .join("-");
}

// Diese Form wird gehasht und verglichen: Bei offenem Startpasswort zählen Bindestriche, Leerzeichen und Gross-/Kleinschreibung nicht
export function normalisiereStartpasswort(text: string) {
  return text.replace(/[-\s]/g, "").toUpperCase();
}

// AES-256-GCM mit einem Schlüssel aus BETTER_AUTH_SECRET: Die Verwaltung zeigt ein offenes Startpasswort wieder an. Ein Wechsel des Geheimnisses macht offene Startpasswörter unlesbar; die Anzeige bleibt dann leer, die Anmeldung unberührt
const schluessel = () =>
  Buffer.from(
    hkdfSync(
      "sha256",
      process.env.BETTER_AUTH_SECRET ?? "",
      "",
      "startpasswort-anzeige",
      32,
    ),
  );

export function verschluesseleStartpasswort(klartext: string) {
  const iv = randomBytes(12);
  const chiffre = createCipheriv("aes-256-gcm", schluessel(), iv);
  const daten = Buffer.concat([
    chiffre.update(klartext, "utf8"),
    chiffre.final(),
  ]);
  return Buffer.concat([iv, chiffre.getAuthTag(), daten]).toString("base64url");
}

export function entschluesseleStartpasswort(text: string | null) {
  if (!text) return null;
  try {
    const roh = Buffer.from(text, "base64url");
    const dechiffre = createDecipheriv(
      "aes-256-gcm",
      schluessel(),
      roh.subarray(0, 12),
    );
    dechiffre.setAuthTag(roh.subarray(12, 28));
    return Buffer.concat([
      dechiffre.update(roh.subarray(28)),
      dechiffre.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

// Felder für ein neues Startpasswort (#18, #20): Pflichtwechsel an, 7 Tage gültig, und die Bremse beginnt von vorn; das Startpasswort selbst bleibt verschlüsselt, bis die Person es ersetzt
export function startpasswortFelder(
  jetzt = new Date(),
  startpasswort?: string,
) {
  return {
    mussPasswortAendern: true,
    startpasswortGueltigBis: new Date(jetzt.getTime() + 7 * TAG),
    startpasswortVerschluesselt: startpasswort
      ? verschluesseleStartpasswort(startpasswort)
      : null,
    fehlversuche: 0,
    naechsterVersuchAb: null,
  };
}
