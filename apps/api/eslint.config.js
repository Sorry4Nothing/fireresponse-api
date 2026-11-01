import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Skript für Postman (#186) läuft in Node; nur die benutzten Namen
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { URL: "readonly", console: "readonly" } },
  },
  {
    // Skripte der Verwaltung laufen im Browser; ohne Abhängigkeit «globals» nur die benutzten Namen
    files: ["public/admin/**/*.js"],
    languageOptions: {
      globals: {
        Blob: "readonly",
        Node: "readonly",
        TextDecoder: "readonly",
        document: "readonly",
        fetch: "readonly",
        location: "readonly",
        navigator: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        window: "readonly",
      },
    },
  },
);
