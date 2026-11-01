import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const SKRIPT = new URL("../../../deploy/naechste-version.sh", import.meta.url);

function lauf(stufe: string, version: string, letzter: string) {
  const r = spawnSync(
    "bash",
    [SKRIPT.pathname.replace(/^\/([A-Za-z]:)/, "$1"), stufe, version, letzter],
    {
      encoding: "utf8",
    },
  );
  return {
    status: r.status,
    ausgabe: r.stdout.trim(),
    fehler: r.stderr.trim(),
  };
}

describe("deploy/naechste-version.sh", () => {
  test.each([
    ["minor", "-", "v0.9.7", "0.9.8"],
    ["minor", "-", "v0.9.9", "0.9.10"],
    ["minor", "-", "v0.9.10", "0.9.11"],
    ["major", "-", "v0.9.9", "0.10.0"],
    ["major", "-", "v0.10.4", "0.11.0"],
    ["major", "-", "v0.99.3", "0.100.0"],
    // x steigt nie von selbst
    ["major", "-", "v1.9.9", "1.10.0"],
    ["minor", "-", "", "0.0.1"],
    // Die ausdrückliche Version gewinnt
    ["minor", "1.0.0", "v0.9.9", "1.0.0"],
    ["minor", "0.10.0", "v0.9.9", "0.10.0"],
    ["minor", "0.9.10", "v0.9.9", "0.9.10"],
  ])("%s %s nach %s gibt %s", (stufe, version, letzter, erwartet) => {
    expect(lauf(stufe, version, letzter)).toMatchObject({
      status: 0,
      ausgabe: erwartet,
    });
  });

  test.each([
    // nicht grösser als der letzte Tag
    ["minor", "0.9.9", "v0.9.9"],
    ["minor", "0.9.8", "v0.9.9"],
    ["minor", "0.9.9", "v0.10.0"],
    ["minor", "0.9", "v0.9.9"],
    // ungültige Nummer
    ["minor", "v1.0.0", "v0.9.9"],
    ["minor", "1.0.0-beta", "v0.9.9"],
    ["minor", "01.0.0", "v0.9.9"],
    ["minor", "1.0.0; echo", "v0.9.9"],
    ["minor", "1234567890.0.0", "v0.9.9"],
    // ungültige Stufe oder ungültiger letzter Tag
    ["patch", "-", "v0.9.9"],
    ["", "-", "v0.9.9"],
    ["minor", "-", "0.9.9"],
    ["minor", "-", "v0.9"],
  ])("%s %s nach %s bricht ab", (stufe, version, letzter) => {
    const r = lauf(stufe, version, letzter);
    expect(r.status).toBe(1);
    expect(r.ausgabe).toBe("");
    expect(r.fehler).not.toBe("");
  });
});
