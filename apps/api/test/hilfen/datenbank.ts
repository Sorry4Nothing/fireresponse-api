// Feste URLs statt DATABASE_URL: Ein Testlauf darf nie eine Datenbank löschen, auf die eine Umgebungsvariable zeigt
export const API_URL =
  "postgres://fireresponse_api@localhost:5432/fireresponse_test";
export const BESITZER_URL =
  "postgres://fireresponse_besitzer@localhost:5432/fireresponse_test";
// Für Sperre und Neuaufbau; in docker-compose.yml und in der CI gilt trust
export const SUPERUSER_URL = "postgres://postgres@localhost:5432/postgres";
