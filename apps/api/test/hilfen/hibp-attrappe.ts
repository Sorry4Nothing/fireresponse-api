// Preload für gespawnte CLI-Prozesse, ohne Vitest: kein Netz im Test, HIBP antwortet aus dieser Attrappe
// HIBP_ATTRAPPE=fehler simuliert einen Ausfall; haveIBeenPwned lehnt dann ab statt durchzulassen
const muster = /^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/;

globalThis.fetch = async (eingabe: RequestInfo | URL) => {
  if (!muster.test(String(eingabe))) {
    throw new Error(`Kein Netz im Test: ${String(eingabe)}`);
  }
  if (process.env.HIBP_ATTRAPPE === "fehler") {
    return new Response("Attrappe: nicht erreichbar", { status: 503 });
  }
  return new Response("", { headers: { "content-type": "text/plain" } });
};

export {};
