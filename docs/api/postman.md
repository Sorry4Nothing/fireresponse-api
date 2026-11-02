# Endpunkte mit Postman prüfen

Die Collection `postman/collections/FireResponse API/` enthält jede Route der Rechte-Matrix (`apps/api/test/rechte-matrix.test.ts`). Ihr Test erwartet den Status, den die Matrix für die gewählte Persona festhält. Mit der Persona `ohneLogin` oder einer fremden Einheit prüft sie also auch Zugriffe ohne Recht (401, 403, 404). Alle Routen und Stati stehen in [endpunkte.md](endpunkte.md).

Die Umgebungen (je Persona eine, mit Sitzung und IDs) enthalten Sitzungen und liegen nur lokal in `apps/api/.postman-lokal/` (git-ignoriert). Sie gehören nie ins Repo.

## Ablauf

Voraussetzung: PostgreSQL aus `docker-compose.yml` läuft, `npm ci` ist gelaufen.

1. Umgebungen erzeugen. Der Test baut die Datenbank `fireresponse_test` neu auf und legt alle Personas an:

   ```sh
   cd apps/api
   POSTMAN_EXPORT=1 npx vitest run test/rechte-matrix.test.ts -t Postman-Export
   ```

2. API auf dieser Datenbank starten (Port 3999, falls 3000 belegt ist). Das Geheimnis muss das Standardgeheimnis von better-auth sein, mit dem der Test die Sitzungen signiert:

   ```sh
   DATABASE_URL=postgres://fireresponse_api@localhost:5432/fireresponse_test APP_MIN_VERSION=0.1.0 PORT=3999 \
   BETTER_AUTH_SECRET=better-auth-secret-12345678901234567890 BETTER_AUTH_URL=https://fireresponse.invalid \
   BETTER_AUTH_TRUSTED_ORIGINS=testapp:// npx tsx src/server.ts
   ```

3. Collection mit der Postman CLI laufen lassen, je Persona einmal:

   ```sh
   postman collection run "postman/collections/FireResponse API" \
     -e apps/api/.postman-lokal/elternJfA.environment.yaml --env-var baseUrl=http://localhost:3999
   ```

   In der Postman-App: Collection-Ordner und eine Umgebung importieren, dann «Run».

## Wichtig

- Ein Lauf verbraucht die Sitzungen (am Ende stehen `sign-out` und `revoke-sessions`) und ändert Daten. Für einen zweiten Lauf Schritt 1 wiederholen und die API neu starten.
- Alle 19 Personas laufen nacheinander gegen dieselbe Datenbank, solange man Schritt 1 nicht dazwischen wiederholt.
- Das Bild-Hochladen (`PUT /api/v1/ich/bild` und `PUT /api/v1/admin/einheiten/:einheitId/raenge/:rangId/abzeichen`) fehlt in der Collection, weil der Body binär ist. Die Matrix prüft es im Test.
- Neue Route: Zeile in die Rechte-Matrix, dann `node apps/api/scripts/postman-erzeugen.mjs` nach Schritt 1, danach `npx prettier --write docs/api/endpunkte.md`; das Skript schreibt `endpunkte.md` und die Collection neu. Beide nicht von Hand ändern.
