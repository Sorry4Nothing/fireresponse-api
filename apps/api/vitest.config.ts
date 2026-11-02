import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./test/frische-datenbank.ts",
    // Die CLI «sitzungen:beenden» löscht jede Sitzung der Testdatenbank, darum läuft ihr Test nach allen anderen Dateien
    projects: [
      {
        test: {
          name: "parallel",
          exclude: [
            ...configDefaults.exclude,
            "test/sitzungen-beenden.test.ts",
          ],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "allein",
          include: ["test/sitzungen-beenden.test.ts"],
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
