# Datenschutz-Folgenabschätzung (DSFA)

**Entwurf, Fassung 2.** Nicht rechtlich geprüft; Stellen mit «[…]» sind zu ergänzen. Grundlage: Art. 22 DSG. Ob eine DSFA Pflicht ist, hängt davon ab, ob die Bearbeitung ein hohes Risiko für die Persönlichkeit der betroffenen Personen bringt. Weil Kinder betroffen sind und die Anmeldungen ausgewertet werden, wird sie vorsichtshalber erstellt. Verantwortlich ist je Bezirk der Bezirk; der Betreiber liefert dieses Dokument für alle Bezirke.

## 1. Beschreibung der Bearbeitung

**Dienst.** FireResponse ist eine App mit Server für Jugend- und Kinderfeuerwehren im Kanton Zürich. Die Termine (Übungen) kommen aus dem Kalender der Einheit. Eltern oder Teilnehmende melden sich mit Ja oder Nein an. Das Kommando sieht, wer kommt. Pushes erinnern an Termine und melden Änderungen.

**Betroffene.** Teilnehmende (oft minderjährig), ihre Eltern, Leitende, Kommandantinnen, Kommandanten und Stellvertretungen, Kantonsadministration.

**Daten.** Die vollständige Liste mit Zweck und Frist je Kategorie steht in `apps/api/src/datenkategorien.ts` und in der Datenschutzerklärung. Kurz: Konto (Name, Benutzername, Passwort-Prüfwert, zweiter Faktor für die Verwaltung), Telefonnummer des Kommandos (freiwillig), Profilbild (freiwillig), Name und Rang der Teilnehmenden, Rollen in Einheiten, Link zum Lodur-Kalender der Einheit (verschlüsselt), Termine, Anmeldungen (Ja, Nein, offen), Push-Token, technische Daten (Sitzungen, IP-Adresse für die Begrenzung der Anfragen, Logs), Protokoll der Verwaltung ohne Personendaten.

**Nicht bearbeitet.** Adresse, Geburtsdatum, Gesundheitsdaten, Standort, Fotos von Kindern, Kommunikation zwischen Personen (kein Chat), Anwesenheit. Der Lodur-Eintrag «Verantwortlich» wird nicht gespeichert.

**Empfänger.** Siehe Datenschutzerklärung: Hosting-Anbieter […], Speicher-Anbieter der Sicherungen […], Push über Google und Apple (Token und Zeitpunkt, kein Name), der Anbieter des Lodur-Kalenders (erhält den Link der Einheit und die Adresse des Servers, keine Personendaten).

**Aufbewahrung.** Siehe Löschkonzept in [README.md](README.md). Offen: Frist für Termine und Anmeldungen.

## 2. Auswertung der Anmeldungen

Die Verwaltung wertet die Anmeldungen aus (Präsenzliste, Teilnahmequote pro Person, Jahresübersicht pro Einheit). Das ist ein eigener Zweck neben der Anmeldung.

- **Zweck:** Planung der Übungen und Gespräch mit den Teilnehmenden und Eltern.
- **Empfänger:** Kommando und Stellvertretungen der eigenen Einheit, Kantonsadministration für alle. Sonst niemand; die App zeigt die Auswertung nicht.
- **Frist:** Die API speichert keine Auswertung. Sie rechnet bei jeder Abfrage aus den Anmeldungen; die Zahlen leben so lange wie diese.
- **Grenzen:** kein Export, keine Anwesenheitskontrolle, keine Weitergabe an Dritte, keine Entscheidung ohne Mensch.
- **Abgrenzung:** kein Tracking, keine Analyse des App-Verhaltens, keine Drittanbieter-SDKs.

## 3. Notwendigkeit und Verhältnismässigkeit

- Die Daten sind das Minimum: Name, Rang, Anmeldung. Telefonnummer und Profilbild sind freiwillig und nur für Personen mit Kontakt zum Kommando sichtbar.
- Die Auswertung braucht keine zusätzlichen Daten über die Anmeldungen hinaus.
- Andere Wege (Papierliste, Chat-Gruppen von Eltern, Tabellen beim Kommando) streuen dieselben Daten ohne Zugriffsregeln und Fristen. Der Dienst begrenzt, wer was sieht.
- Die Rechtsgrundlage ist [Einwilligung der betroffenen Personen bzw. ihrer Eltern, öffentliches oder privates Interesse der Einheit]. […]

## 4. Risiken für die betroffenen Personen

| Nr. | Risiko                                                                                          | Schwere | Wahrscheinlichkeit | Massnahme                                                                                                                                                                                                               | Restrisiko |
| --- | ----------------------------------------------------------------------------------------------- | ------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Unbefugte lesen Namen und Anmeldungen von Kindern                                               | hoch    | tief               | Zugriff nach Rolle und Einheit in jeder Abfrage, Rechte-Matrix als Test, zweiter Faktor für die Verwaltung, verschlüsselte Übertragung und Sicherungen                                                                  | tief       |
| 2   | Kontoübernahme (Passwort erraten oder gestohlenes Gerät)                                        | mittel  | mittel             | Wartezeit nach Fehlversuchen, Abgleich mit Datenlecks, Sitzungen widerrufbar, Schlüsselspeicher in der App                                                                                                              | tief       |
| 3   | Zweckentfremdung der Auswertung (Druck auf einzelne Kinder)                                     | mittel  | tief               | Zweckbindung in den Nutzungsbedingungen, nur Kommando der eigenen Einheit, kein Export, Information im Elternbrief                                                                                                      | tief       |
| 4   | Falsche Zahlen: Anmeldung ist nicht Anwesenheit                                                 | tief    | mittel             | Die Auswertung heisst «Anmeldungen» und sagt, was sie nicht misst                                                                                                                                                       | tief       |
| 5   | Pushes verraten Namen auf dem Sperrbildschirm                                                   | mittel  | tief               | Pushes tragen nie Namen und nie Inhalte eines Termins, nur Titel und Tag des Programms                                                                                                                                  | tief       |
| 6   | Kantonsadministration sieht Daten aller Bezirke                                                 | mittel  | tief               | In den Nutzungsbedingungen offengelegt, zweiter Faktor, Audit-Log                                                                                                                                                       | mittel     |
| 7   | Daten bleiben zu lange                                                                          | mittel  | mittel             | Konto löschen in der Verwaltung, Löschkonzept, Logs 14 Tage, Aufbewahrungsfrist […]                                                                                                                                     | mittel     |
| 8   | Übermittlung ins Ausland (Push über Google und Apple)                                           | tief    | hoch               | Token, Zeitpunkt, Titel und Tag des Programms, keine Namen und keine Inhalte; vertragliche Zusicherungen der Anbieter […]                                                                                               | tief       |
| 9   | Datenverlust oder Ausfall                                                                       | tief    | tief               | Tägliche verschlüsselte Sicherung, Rücksicherungstest pro Quartal                                                                                                                                                       | tief       |
| 10  | Datenpanne bleibt unbemerkt                                                                     | hoch    | tief               | Anfrage-Log, Ablauf «Datenpanne» in `docs/betrieb.md`, Meldung an den EDÖB bei hohem Risiko                                                                                                                             | mittel     |
| 11  | Lodur-Link gelangt in falsche Hände oder die API ruft eine fremde Adresse ab                    | mittel  | tief               | Link verschlüsselt gespeichert, nie in Antwort oder Log; nur https, nur Hosts von der Liste des Betreibers, keine Weiterleitungen, interne Adressen blockiert; Kommando kann den Link jederzeit ersetzen oder entfernen | tief       |
| 12  | Widget (Android) zeigt Vornamen der Kinder ohne Entsperren, auch bei eingeschalteter App-Sperre | mittel  | mittel             | Das Widget ist freiwillig (nicht platzieren); die Datenschutzerklärung nennt es offen samt Hintergrundabruf alle 30 Minuten und Speicherung nur im Arbeitsspeicher und im Widget-Speicher von Android                   | mittel     |

Die technischen Bedrohungen und Massnahmen stehen im [Bedrohungsmodell](../sicherheit/bedrohungsmodell.md).

## 5. Ergebnis

Mit den genannten Massnahmen bleiben die Restrisiken tief bis mittel. Mittel bleiben die Sicht der Kantonsadministration auf alle Bezirke, die Aufbewahrungsdauer (bis die Frist festgelegt ist) und die Erkennung einer Datenpanne. Eine Konsultation des EDÖB (Art. 23 DSG) ist [nach rechtlicher Prüfung zu entscheiden; bei diesen Restrisiken voraussichtlich nicht nötig].

## 6. Massnahmen vor dem Start

- Aufbewahrungsfrist festlegen und eintragen.
- Hoster, Standort und Auftragsverhältnis klären; Region wählen und festhalten.
- Datenschutzerklärung, Nutzungsbedingungen und Elternbrief rechtlich prüfen lassen.
- Verfahren nach einer Wiederherstellung (gelöschte Konten erneut löschen) in `docs/betrieb.md` aufnehmen.
- Diese DSFA bei jeder neuen Auswertung, jedem neuen Empfänger und jeder neuen Datenart überarbeiten.
