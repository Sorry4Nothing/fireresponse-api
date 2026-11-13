# Datenschutzdokumente

Diese Dokumente gehören zu FireResponse. Der Betreiber liefert sie fertig; es gilt ein Satz für alle Bezirke, nicht pro Bezirk angepasst.

**Stand: Entwurf.** Die Texte sind aus den tatsächlichen Datenkategorien des Systems abgeleitet, aber nicht rechtlich geprüft. Vor der Veröffentlichung prüft eine Fachperson sie und ergänzt die Stellen mit «[…]». Das ist keine Rechtsberatung.

## Übersicht

| Dokument                                    | Wo                                                                       | Zweck                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Datenschutzerklärung (Art. 19 DSG)          | `apps/api/public/datenschutz.html`, Route `/datenschutz`                 | Information der betroffenen Personen; die Kategorien kommen aus `src/datenkategorien.ts`                  |
| Nutzungsbedingungen mit Auftragsbearbeitung | `apps/api/public/nutzungsbedingungen.html`, Route `/nutzungsbedingungen` | Regeln für Bezirke und Konten; Zustimmung der Bezirke durch die Nutzung; Auftragsbearbeitung (Art. 9 DSG) |
| Einwilligung beim ersten Start              | `src/einwilligung.ts`, `GET /api/v1/einwilligung`                        | Kurztext, den die Apps zeigen; verweist auf die beiden Seiten                                             |
| Elternbrief                                 | [elternbrief.md](elternbrief.md)                                         | Vorlage, die die Einheiten an die Eltern geben                                                            |
| Datenschutz-Folgenabschätzung (Art. 22 DSG) | [dsfa.md](dsfa.md)                                                       | Risiken und Massnahmen, inklusive Auswertung der Anmeldungen                                              |
| Bedrohungsmodell                            | [../sicherheit/bedrohungsmodell.md](../sicherheit/bedrohungsmodell.md)   | Sicherheit der Daten: Bedrohungen, Massnahmen, Restrisiken                                                |
| Konto löschen                               | `apps/api/public/konto-loeschen.html`, Route `/konto-loeschen`           | Wie ein Konto gelöscht wird und was bleibt                                                                |

## Zustimmung und Fassung

- **Bezirke:** Ein Bezirk stimmt den Nutzungsbedingungen und der Auftragsbearbeitung durch die Nutzung zu (Abschnitt 2 der Nutzungsbedingungen). Die API speichert dazu nichts und sperrt nichts; es gibt keinen Zustimmungsvermerk am Bezirk.
- **Konten:** Jedes Konto stimmt beim ersten Start der App zu. Die API sperrt bis dahin alle App-Routen (siehe `docs/architektur.md`) und speichert Datum und Fassung am Konto (`user.einwilligung_am`, `user.einwilligung_version`).
- **Fassung:** `EINWILLIGUNG_VERSION` in `src/einwilligung.ts` ist die Fassung beider Seiten und des Einwilligungstextes; die Seiten zeigen sie als «Fassung n». Ändert sich ein Text inhaltlich, steigt die Zahl, und alle Konten stimmen neu zu. Tippfehler und Layout ändern sie nicht. Die DSFA und der Elternbrief tragen dieselbe Fassung im Kopf.

## Vor der Veröffentlichung

1. Rechtlich prüfen lassen, besonders: Wer ist verantwortlich, wer Auftragsbearbeiter? Wer die Dokumente vorgibt und den Zweck mitbestimmt, kann selbst als (Mit-)Verantwortlicher gelten. Die Texte gehen von «Bezirk verantwortlich, Betreiber Auftragsbearbeiter» aus.
2. Die Stellen mit «[…]» ergänzen: Hosting-Anbieter und Standort, Speicher-Anbieter der Sicherungen, rechtliche Grundlage der Datenübermittlung ins Ausland (Apple, Google), Haftung, Gerichtsstand.
3. Aufbewahrungsfrist für Termine und Anmeldungen festlegen und in `src/datenkategorien.ts` eintragen. Heute steht dort «bis das Kommando löscht».
4. In allen Seiten und Dokumenten den Hinweis «Entwurf» entfernen.
5. `VERANTWORTLICHE_STELLE` und `KONTAKT_EMAIL` im Betrieb setzen (siehe `docs/betrieb.md`).
6. Die Angaben für Apple «App Privacy» und Google «Data safety» aus `src/datenkategorien.ts` gegen die aktuellen Formulare prüfen.
7. Mit den Stores klären, ob das Löschen von Konten über die Verwaltung genügt. Apple verlangt bei Apps mit Kontoerstellung grundsätzlich eine Löschfunktion in der App; hier entstehen Konten durch das Kommando, nicht in der App.

## Löschkonzept

| Daten                                                                                                     | Wer löscht                                                                         | Wann                                                                                              |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Konto, Sitzungen, zweiter Faktor, Rollen, Verknüpfungen, Profilbild, Push-Tokens, Anmeldungen der Leitung | Kommando oder Kantonsadmin über `DELETE /api/v1/admin/konten/{userId}`             | auf Anfrage, sofort                                                                               |
| Telefonnummer, Profilbild                                                                                 | die Person selbst, sonst mit dem Konto                                             | jederzeit                                                                                         |
| Teilnehmende und ihre Anmeldungen                                                                         | Kommando                                                                           | auf Anfrage; Aufbewahrungsfrist offen                                                             |
| Termine                                                                                                   | Kommando oder der Kalender der Einheit                                             | Aufbewahrungsfrist offen                                                                          |
| Link zum Lodur-Kalender und Stand des Abrufs                                                              | Kommando oder Kantonsadmin über `DELETE /api/v1/admin/einheiten/{einheitId}/lodur` | auf Anfrage, sofort; die Termine bleiben, es kommen keine neuen                                   |
| Mitteilungen im Infokanal (geplant, Issue #208)                                                           | die Schreibenden (eigene), das Kommando (fremde), sonst die API                    | sofort (Text), nach 6 Monaten automatisch (ganze Mitteilung)                                      |
| Sitzungen                                                                                                 | die API                                                                            | täglich nach Ablauf (90 Tage ohne Nutzung)                                                        |
| Nachrichten der Glocke und Lesemarken                                                                     | Kantonsadmin (Zurückziehen), sonst die API                                         | täglich, 6 Monate nach Ablauf, ohne Ablauf 6 Monate nach dem Erstellen                            |
| Server-Logs                                                                                               | journald                                                                           | nach 14 Tagen                                                                                     |
| Eintrag im Audit-Log                                                                                      | niemand                                                                            | bleibt, enthält nur IDs                                                                           |
| Sicherungen                                                                                               | restic                                                                             | nach Ablauf der Aufbewahrung (30 tägliche, 3 monatliche Stände, bis 30 Tage länger beim Anbieter) |

Nach einer Wiederherstellung aus einer Sicherung sind Konten, die danach gelöscht wurden, erneut zu löschen. Das Verfahren gehört in `docs/betrieb.md`.

## Geplant: Kategorie «Mitteilungen im Infokanal»

Der Infokanal (Issue #208) ist beschlossen, aber noch nicht gebaut. Die Kategorie kommt in `src/datenkategorien.ts`, sobald seine Tabellen im Schema stehen; vorher scheitert `test/datenkategorien.test.ts` (jede Kategorie braucht Spalten). Weil `src/datenkategorien.ts` die Datenschutzerklärung füllt, ändert die neue Kategorie deren Wortlaut: Das braucht eine neue Fassung (`EINWILLIGUNG_VERSION` steigt, alle Konten stimmen neu zu) und die Freigabe des Verantwortlichen. Bis dahin steht der Entwurf nur hier und in der DSFA.

- **Titel:** Mitteilungen im Infokanal
- **Zweck:** Kommando und Leitung informieren die Konten ihrer Einheit in einer Richtung (Text, Absender mit Rolle, Zeitpunkt, Einheit). Keine Antworten, keine Reaktionen, keine Anhänge.
- **Frist:** 6 Monate, dann löscht das System die Mitteilung automatisch. Eine gelöschte Mitteilung verliert den Text sofort; nur ein Platzhalter bleibt bis dahin.
- **Empfänger:** die Konten der Einheit (lesen), Kommando und Leitung der Einheit (schreiben). Der Push nennt nur «Neue Mitteilung» mit dem Namen der Einheit, nie den Text; er läuft über Google und Apple.
- **Store-Angaben (Apple, Google):** noch zu bestimmen; der Text der Mitteilungen ist Inhalt, den Personen eingeben.

Ebenfalls neu und noch nicht in der Datenschutzerklärung: frei formulierte Push-Mitteilungen aus der Verwaltung (Issue #207), die Übertragung von Teilnehmenden zwischen Einheiten (Issue #210) und die Warteliste mit Sichtbarkeit der angemeldeten Leitenden (Issue #212). Sie ändern die Weitergabe von Daten (siehe [dsfa.md](dsfa.md), Abschnitt 2a) und gehören vor dem Bau in die Erklärung und in den Elternbrief.

## Pflege

- Neue Tabelle oder Spalte: `src/datenkategorien.ts` ergänzen. Der Test `test/datenkategorien.test.ts` scheitert sonst; er prüft auch, dass die Datenschutzerklärung jede Kategorie mit Zweck und Frist nennt.
- Neue Auswertung, neuer Empfänger, neue Datenart: Datenschutzerklärung, DSFA, Elternbrief und Bedrohungsmodell prüfen; im Zweifel `EINWILLIGUNG_VERSION` erhöhen.
