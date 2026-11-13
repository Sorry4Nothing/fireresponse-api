import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./test/frische-datenbank.ts",
    // Die CLI «sitzungen:beenden» löscht jede Sitzung der Testdatenbank, und die Wartung sperrt alle App-Routen: Beide Tests laufen darum nach allen anderen Dateien
    projects: [
      {
        test: {
          name: "parallel",
          exclude: [
            ...configDefaults.exclude,
            "test/sitzungen-beenden.test.ts",
            "test/wartung.test.ts",
          ],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "allein",
          include: ["test/sitzungen-beenden.test.ts", "test/wartung.test.ts"],
          // Eine Datei nach der anderen: Beide ändern globalen Zustand
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
