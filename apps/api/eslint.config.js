import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  // Fremder Code (qrcode-generator, MIT) unverändert
  { ignores: ["public/admin/qrcode.js"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Skript für Postman läuft in Node; nur die benutzten Namen
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
        URL: "readonly",
        URLSearchParams: "readonly",
        history: "readonly",
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
