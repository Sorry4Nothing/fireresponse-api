import { anfrage, fehlertext } from "./api.js";
import { codefeld, el, feld, icon, knopf } from "./dom.js";
import { qrcode } from "./qrcode.js";

// Zweiten Faktor (Authenticator-App) für ein Konto der Verwaltung einrichten: Passwort bestätigen, Schlüssel und Ersatzcodes sichern, Code bestätigen. Das Konto gehört dann zum Faktor, nicht die einzelne Sitzung.

const SVG_NS = "http://www.w3.org/2000/svg";

// Der QR-Code entsteht hier im Browser aus dem Link des Authenticators; das Geheimnis geht an keinen Dienst. Immer dunkel auf hellem Grund mit ruhiger Zone von 4 Modulen, auch im Dunkelmodus: Sonst liest ihn keine Kamera
export function qrBild(inhalt) {
  const qr = qrcode(0, "M");
  qr.addData(inhalt, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const rand = 4;
  const gross = n + 2 * rand;
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [name, wert] of Object.entries({
    class: "qr",
    viewBox: `0 0 ${gross} ${gross}`,
    role: "img",
    "aria-label": "QR-Code für die Authenticator-App",
    "shape-rendering": "crispEdges",
  })) {
    svg.setAttribute(name, wert);
  }
  const grund = document.createElementNS(SVG_NS, "rect");
  grund.setAttribute("width", String(gross));
  grund.setAttribute("height", String(gross));
  grund.setAttribute("fill", "#ffffff");
  // Ein Pfad für alle dunklen Module
  let d = "";
  for (let zeile = 0; zeile < n; zeile++) {
    for (let spalte = 0; spalte < n; spalte++) {
      if (qr.isDark(zeile, spalte)) {
        d += `M${spalte + rand} ${zeile + rand}h1v1h-1z`;
      }
    }
  }
  const module = document.createElementNS(SVG_NS, "path");
  module.setAttribute("d", d);
  module.setAttribute("fill", "#000000");
  svg.append(grund, module);
  return svg;
}

const gruppiert = (schluessel) => schluessel.replace(/(.{4})(?=.)/g, "$1 ");

// seite: anmeldeSeite aus admin.js; fertig(): weiter zur Verwaltung; abmelden(): Sitzung beenden
export function zeigeEinrichtung({ seite, fertig, abmelden }) {
  const fehler = () =>
    el("p", {
      class: "hinweis hinweis--fehler",
      role: "alert",
      hidden: true,
      tabindex: "-1",
    });
  const zeigeFehler = (knoten, f) => {
    knoten.textContent = fehlertext(f);
    knoten.hidden = false;
    knoten.focus();
  };

  function schritt1() {
    const passwort = feld({
      label: "Dein Passwort",
      typ: "password",
      autocomplete: "current-password",
      hilfe: "Zur Sicherheit fragen wir vor der Einrichtung nochmals nach.",
      required: true,
    });
    const meldung = fehler();
    const senden = el(
      "button",
      { type: "submit", class: "knopf knopf--haupt knopf--gross" },
      "Weiter",
    );
    const formular = el(
      "form",
      { class: "formular", novalidate: true },
      passwort.wurzel,
      meldung,
      senden,
      knopf("Abmelden", { art: "still", onclick: abmelden }),
    );
    formular.addEventListener("submit", async (ereignis) => {
      ereignis.preventDefault();
      meldung.hidden = true;
      if (!passwort.eingabe.value) {
        meldung.textContent = "Bitte gib dein Passwort ein.";
        meldung.hidden = false;
        meldung.focus();
        return;
      }
      senden.disabled = true;
      try {
        const antwort = await anfrage("POST", "/api/auth/two-factor/enable", {
          password: passwort.eingabe.value,
        });
        passwort.eingabe.value = "";
        schritt2(antwort);
      } catch (f) {
        zeigeFehler(meldung, f);
      } finally {
        senden.disabled = false;
      }
    });
    seite({
      ueber: "Zweiter Faktor einrichten · Schritt 1 von 2",
      titel: "Zweiten Faktor einrichten",
      text: "Die Verwaltung schützt jedes Konto mit einem zweiten Faktor: einem Code aus einer Authenticator-App auf deinem Handy.",
      kopfzeichen: el("span", { class: "kreis" }, icon("schild")),
      inhalt: [formular],
    });
  }

  function schritt2({ totpURI, backupCodes }) {
    const schluessel = new URL(totpURI).searchParams.get("secret") ?? "";
    const rueck = el("p", { class: "hilfe", role: "status" });
    const kopiere = (text) => async () => {
      try {
        await navigator.clipboard.writeText(text);
        rueck.textContent = "Kopiert.";
      } catch {
        rueck.textContent =
          "Kopieren ist nicht möglich. Markiere den Text von Hand.";
      }
    };
    const code = codefeld({
      label: "Code aus der Authenticator-App",
      hilfe: "Sechs Ziffern. Der Code wird nach der letzten Ziffer geprüft.",
      required: true,
    });
    const meldung = fehler();
    const senden = el(
      "button",
      { type: "submit", class: "knopf knopf--haupt knopf--gross" },
      "Bestätigen",
    );
    const formular = el(
      "form",
      { class: "formular", novalidate: true },
      el("h2", {}, "1. QR-Code scannen"),
      el(
        "p",
        { class: "hilfe" },
        "Scanne den QR-Code mit deiner Authenticator-App.",
      ),
      el("div", { class: "qr-rahmen" }, qrBild(totpURI)),
      // Nur für den Fall, dass die Kamera nicht geht: eingeklappt, damit der Schlüssel nicht im Weg steht
      el(
        "details",
        { class: "qr-ausweg" },
        el("summary", {}, "Scannen nicht möglich?"),
        el(
          "p",
          { class: "hilfe" },
          "Gib diesen Schlüssel in der App ein (Typ: zeitbasiert).",
        ),
        el("p", { class: "geheimnis" }, gruppiert(schluessel)),
      ),
      el("h2", {}, "2. Ersatzcodes sichern"),
      el(
        "p",
        { class: "hilfe" },
        "Mit einem Ersatzcode kommst du hinein, wenn du dein Handy nicht hast. Jeder Code gilt nur einmal. Sie erscheinen nur jetzt.",
      ),
      el(
        "ul",
        { class: "ersatzcodes" },
        backupCodes.map((c) => el("li", { class: "mono" }, c)),
      ),
      knopf("Ersatzcodes kopieren", {
        symbol: "kopieren",
        onclick: kopiere(backupCodes.join("\n")),
      }),
      rueck,
      el("h2", {}, "3. Code bestätigen"),
      code.wurzel,
      meldung,
      senden,
    );
    formular.addEventListener("submit", async (ereignis) => {
      ereignis.preventDefault();
      meldung.hidden = true;
      const wert = code.eingabe.value.trim();
      if (!wert) {
        meldung.textContent = "Bitte gib den Code ein.";
        meldung.hidden = false;
        meldung.focus();
        return;
      }
      senden.disabled = true;
      try {
        await anfrage("POST", "/api/auth/two-factor/verify-totp", {
          code: wert,
        });
        fertig();
      } catch (f) {
        code.eingabe.value = "";
        code.eingabe.dispatchEvent(new window.Event("input"));
        code.eingabe.setAttribute("aria-invalid", "true");
        zeigeFehler(meldung, f);
      } finally {
        senden.disabled = false;
      }
    });
    seite({
      ueber: "Zweiter Faktor einrichten · Schritt 2 von 2",
      titel: "QR-Code und Ersatzcodes",
      text: "Scanne den QR-Code, sichere die Ersatzcodes und bestätige mit einem Code.",
      kopfzeichen: el("span", { class: "kreis" }, icon("schild")),
      inhalt: [formular],
    });
  }

  schritt1();
}
