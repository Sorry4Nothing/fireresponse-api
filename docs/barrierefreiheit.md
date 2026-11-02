# Checkliste Barrierefreiheit

Mit dieser Checkliste wird jeder Bildschirm der App von Hand geprüft, auf einem iPhone und einem Android-Gerät. Massstab ist WCAG 2.2 AA, sinngemäss für Apps.

## Wann prüfen

- Neuer Bildschirm: mindestens die Punkte aus Abschnitt 1 mit VoiceOver und TalkBack, dazu alle anderen Punkte, die er berührt.
- Geänderter Bildschirm: die Punkte, die die Änderung berührt.
- Vor dem Pilot und vor Version 1.0: alle Punkte auf jedem Bildschirm.
- Ein Punkt ohne Angabe des Systems gilt für iOS und Android. Punkte, die auf einen Bildschirm nicht zutreffen, entfallen.
- Die Nummern bleiben fest, damit ältere PRs stimmen: Neue Punkte kommen ans Ende ihres Abschnitts.

## Vorbereitung

- Geprüft wird auf echten Geräten. Ausser dem Kontrastprüfer am PC laufen alle Werkzeuge auf den Geräten selbst, einen Mac braucht es nicht.
- iPhone: VoiceOver, Schaltersteuerung, Sprachsteuerung, «Grösserer Text» und «Bewegung reduzieren» liegen unter «Einstellungen > Bedienungshilfen».
- Grösste Schrift auf dem iPhone: bei «Grösserer Text» die grösseren Schriftgrössen einschalten und den Regler ganz nach rechts schieben.
- Android: TalkBack liegt in den Einstellungen bei den Bedienungshilfen; der Weg dorthin hängt vom Hersteller ab. Switch Access («Schalterzugriff»), Voice Access und Accessibility Scanner gibt es in Google Play; nach der Installation stehen sie bei den Bedienungshilfen.
- Das Android-Gerät hat Android 14 oder neuer, weil die Schrift erst dort bis 200 % geht.
- Schaltersteuerung ohne externen Schalter: unter «Schaltersteuerung > Schalter > Neuen Schalter hinzufügen» die Quelle «Bildschirm» wählen und ihr «Objekt auswählen» zuweisen. Dreimal schnell die Seitentaste drücken beendet die Schaltersteuerung.
- Switch Access ohne externen Schalter: TalkBack und das automatische Scannen ausschalten, dann die Lautstärketasten als Schalter zuweisen. Lautstärke leiser springt zum nächsten Element, lauter wählt es aus.

## 1. Screenreader: VoiceOver (iOS) und TalkBack (Android)

- [ ] **1.1** Mit Wischen nach rechts erreicht man alle Inhalte in sinnvoller Reihenfolge. Nichts fehlt, nichts kommt doppelt.
- [ ] **1.2** Jedes Bedienelement wird mit Name, Rolle und Zustand angesagt (`accessibilityLabel`, `accessibilityRole`, `accessibilityState`).
- [ ] **1.3** Der angesagte Name beginnt mit dem sichtbaren Text.
- [ ] **1.4** Die Ja/Nein-Auswahl sagt auf beiden Systemen an, welche Antwort gewählt ist.
- [ ] **1.5** Überschriften werden als Überschrift angesagt (`accessibilityRole="header"`).
- [ ] **1.6** Symbole mit Bedeutung haben einen Namen. Reine Zierde wird übersprungen.
- [ ] **1.7** Meldungen, die ohne Fokuswechsel erscheinen, werden angesagt, ohne eine laufende Ansage abzubrechen (Android: Statustext mit `accessibilityLiveRegion="polite"`, iOS: `AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: true })`).

## 2. Schaltersteuerung (iOS) und Switch Access (Android)

- [ ] **2.1** Jedes Bedienelement lässt sich mit dem Schalter erreichen und auslösen.
- [ ] **2.2** Lange Listen lassen sich mit dem Schalter bis zum Ende scrollen.

## 3. Sprachsteuerung (iOS) und Voice Access (Android)

- [ ] **3.1** Jedes Bedienelement lässt sich mit dem Text auslösen, der darauf steht.
- [ ] **3.2** Mit eingeblendeten Nummern trägt jedes Bedienelement eine Nummer.

## 4. Accessibility Scanner (Android)

- [ ] **4.1** Der Scan des Bildschirms ergibt keinen Vorschlag, oder der PR begründet jeden, der bleibt.

Auf dem iPhone gibt es keinen Scanner. Den Kontrast (5.5) misst man dort an einem Bildschirmfoto mit einem Kontrastprüfer am PC. Die Grösse der Touch-Ziele (5.7) steht im Code: Grösse plus `hitSlop`, in pt auf iOS und dp auf Android; `hitSlop` zählt nur innerhalb des übergeordneten Elements. Das ist vor allem dort nötig, wo iOS anders aussieht als Android.

## 5. Darstellung

- [ ] **5.1** Bei grösster Schrift wird kein Text abgeschnitten, überdeckt oder gekürzt; Zeilen brechen um.
- [ ] **5.2** Bei grösster Schrift bleibt alles erreichbar; wo der Platz nicht reicht, scrollt der Bildschirm.
- [ ] **5.3** Im Code steht kein `allowFontScaling={false}` und kein `maxFontSizeMultiplier` unter 2 ausser 0 (0 heisst: keine Grenze).
- [ ] **5.4** Die App folgt dem Dunkelmodus des Systems. Im hellen und im dunklen Modus ist alles gut lesbar.
- [ ] **5.5** Der Kontrast beträgt mindestens 4.5:1 für Text und 3:1 für Bedienelemente, hell und dunkel.
- [ ] **5.6** Ein Zustand zeigt sich nie nur über Farbe, sondern immer mit Symbol und Text.
- [ ] **5.7** Touch-Ziele sind mindestens 44 × 44 pt (iOS) bzw. 48 × 48 dp (Android) gross.
- [ ] **5.8** Jeder Bildschirm dreht ins Querformat mit und bleibt dort ganz bedienbar (`orientation: "default"`).
- [ ] **5.9** Mit «Bewegung reduzieren» (iOS) bzw. ausgeschalteten Animationen (Android) gleitet und zoomt nichts; Wechsel blenden höchstens über.
- [ ] **5.10** Bei grösster Schrift ist jeder Text deutlich grösser als bei Standardgrösse. Ausnahme: die Tab-Leiste auf iOS, wenn langes Drücken auf einen Tab seinen Namen vergrössert anzeigt.

## 6. Fokus

Fokus heisst hier: das Element, das Screenreader oder Schalter gerade ausgewählt hat, oder das Textfeld, in das man gerade schreibt.

- [ ] **6.1** Nach einer Navigation liegt der Fokus auf der Überschrift des neuen Bildschirms.
- [ ] **6.2** Nach dem Schliessen eines Dialogs liegt der Fokus wieder auf dem Element, das ihn geöffnet hat.
- [ ] **6.3** Nach einem Fehler liegt der Fokus auf der Fehlermeldung.
- [ ] **6.4** Der Fokus liegt nie unter Tab-Leiste, Tastatur oder Eingabezeile; der Inhalt scrollt mit.
- [ ] **6.5** Öffnet sich ein Dialog, liegt der Fokus im Dialog. Screenreader und Schalter erreichen nichts dahinter, bis er geschlossen ist.

## 7. App-Sperre

- [ ] **7.1** Solange die Sperre angezeigt wird, erreichen Screenreader, Schalter und Sprachsteuerung nur die Elemente der Sperre, nichts darunter (iOS: `accessibilityViewIsModal` auf der Sperre, Android: `importantForAccessibility="no-hide-descendants"` auf dem Inhalt darunter).
- [ ] **7.2** Ein angefangener Entwurf, z. B. ein Formular, ist nach dem Entsperren noch da.

## 8. Gesten und Zeit

- [ ] **8.1** Jede Wisch-, Zieh- oder Mehrfingeraktion lässt sich auch mit einem Finger ohne Wischen und Ziehen auslösen, mit einem Knopf oder über ein Menü. Für Screenreader und Schalter gibt es sie zusätzlich als Aktion (`accessibilityActions` mit `onAccessibilityAction`).
- [ ] **8.2** Ausser der App-Sperre gibt es kein Zeitlimit: Keine Eingabe läuft ab, keine Meldung verschwindet von selbst.

## 9. Textfelder und Login

`autoComplete` wirkt auf beiden Systemen (einzelne Werte nur auf Android), `textContentType` nur auf iOS.

- [ ] **9.1** Benutzername: `autoComplete="username"` und `textContentType="username"`.
- [ ] **9.2** Passwort beim Anmelden: `autoComplete="current-password"` und `textContentType="password"`.
- [ ] **9.3** Neues Passwort: `autoComplete="new-password"`, `textContentType="newPassword"` und auf iOS `passwordRules="minlength: 12;"`.
- [ ] **9.4** Code des zweiten Faktors aus der Authenticator-App: auf iOS `textContentType="oneTimeCode"`, auf Android `autoComplete="2fa-app-otp"`. Auf Android nicht `one-time-code`: React Native macht daraus den Hinweis für SMS-Codes.
- [ ] **9.5** Der Passwort-Manager des Geräts füllt Benutzername und Passwort aus.
- [ ] **9.6** Einfügen geht in jedem Textfeld (kein `contextMenuHidden`).
- [ ] **9.7** Es gibt kein Feld zum Wiederholen des Passworts.
- [ ] **9.8** «Passwort anzeigen» sagt an, ob das Passwort gerade sichtbar ist.
- [ ] **9.9** Fehler stehen als Text beim betroffenen Feld und werden angesagt.
- [ ] **9.10** Jedes Textfeld hat eine sichtbare Beschriftung, die beim Tippen stehen bleibt. Ein Platzhalter allein reicht nicht.

## 10. Sprache und Texte

- [ ] **10.1** Auf iOS ist Deutsch als Sprache der App gesetzt (`CFBundleDevelopmentRegion` `de`).
- [ ] **10.2** Ist das Gerät auf Englisch gestellt, liest der Screenreader die App trotzdem mit deutscher Aussprache vor.
- [ ] **10.3** Die Texte sind in einfacher Sprache: kurze Sätze, bekannte Wörter.
- [ ] **10.4** Schweizer Schreibweise: immer ss, kein Eszett.
- [ ] **10.5** Anführungszeichen sind «».

## Im PR angeben

Bei UI-Änderungen nennt der PR-Text unter «Evidence»:

- die geprüften Punkte mit Nummer
- Gerät und Systemversion
- was nicht geprüft werden konnte, und warum
- offene Befunde mit der Nummer ihres Issues (Label `accessibility`)

Beispiel:

```text
Geprüft auf <Gerät> mit Android <Version>: 1.1–1.7, 2.1, 5.1–5.4, 6.1, 6.3
Nicht geprüft: iPhone, noch kein Dev-Build
Offen: 5.1 bei grösster Schrift (#<Issue>)
```
