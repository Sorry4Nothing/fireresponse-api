import { describe, expect, test } from "vitest";

// Die Verwaltung erzeugt den QR-Code des zweiten Faktors im Browser mit dem Modul unter public/admin. Die Datei hat keine Typen; ein Pfad aus einer URL hält den Import ungeprüft
interface Qr {
  addData(daten: string, modus: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(zeile: number, spalte: number): boolean;
}
const { qrcode } = (await import(
  new URL("../public/admin/qrcode.js", import.meta.url).href
)) as { qrcode: (version: number, stufe: string) => Qr };

// So sieht der Link aus, den better-auth über auth.ts liefert: 52 Zeichen Schlüssel, 6 Stellen, 30 s
const LINK =
  "otpauth://totp/FireResponse:robin.admin?secret=NJZDAN2DG53UWQJSKVQVMMCMNEZTGXZQGRYEY6BQK4ZXSRDFHBVQ&issuer=FireResponse&digits=6&period=30";

function erzeuge(daten: string) {
  const qr = qrcode(0, "M");
  qr.addData(daten, "Byte");
  qr.make();
  return qr;
}

const gitter = (qr: Qr) =>
  Array.from({ length: qr.getModuleCount() }, (_, z) =>
    Array.from({ length: qr.getModuleCount() }, (_, s) => qr.isDark(z, s)),
  );

describe("QR-Code des zweiten Faktors", () => {
  test("der Link passt in Version 8 (49 × 49 Module) mit Fehlerkorrektur M", () => {
    expect(LINK.length).toBeGreaterThan(122);
    expect(LINK.length).toBeLessThanOrEqual(152);
    expect(erzeuge(LINK).getModuleCount()).toBe(49);
  });

  test("die drei Suchmuster sitzen in den Ecken, rechts unten keines", () => {
    const g = gitter(erzeuge(LINK));
    const n = g.length;
    // 7 × 7: dunkler Rahmen, heller Ring, dunkler Kern 3 × 3
    const suchmuster = (z0: number, s0: number) => {
      for (let z = 0; z < 7; z++) {
        for (let s = 0; s < 7; s++) {
          const rand = z === 0 || z === 6 || s === 0 || s === 6;
          const kern = z >= 2 && z <= 4 && s >= 2 && s <= 4;
          expect(g[z0 + z][s0 + s], `${z0 + z}/${s0 + s}`).toBe(rand || kern);
        }
      }
    };
    suchmuster(0, 0);
    suchmuster(0, n - 7);
    suchmuster(n - 7, 0);
    // Die Trennlinie um das erste Suchmuster ist hell
    for (let i = 0; i < 8; i++) {
      expect(g[7][i]).toBe(false);
      expect(g[i][7]).toBe(false);
    }
  });

  test("gleiche Eingabe, gleiches Bild; ein anderer Schlüssel ergibt ein anderes", () => {
    expect(gitter(erzeuge(LINK))).toEqual(gitter(erzeuge(LINK)));
    expect(gitter(erzeuge(LINK.replace("NJZD", "AAAA")))).not.toEqual(
      gitter(erzeuge(LINK)),
    );
  });

  test("die Grösse wächst mit dem Inhalt, und zu viel Inhalt wirft", () => {
    expect(erzeuge("otpauth://x").getModuleCount()).toBeLessThan(49);
    expect(() => erzeuge("x".repeat(3000))).toThrow();
  });
});
