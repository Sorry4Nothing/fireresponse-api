import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import { ladeSeiten } from "../src/seiten.js";
import { bereiteAuthTestsVor, erstelleTestAuth } from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";

bereiteAuthTestsVor();

const sql = postgres(API_URL);
const db = erstelleDb(sql);
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth: erstelleTestAuth(db),
  seiten: ladeSeiten(),
});
afterAll(() => sql.end());

const METHODEN = ["get", "put", "post", "patch", "delete"];

const doc = parse(
  readFileSync(
    new URL("../../../docs/api/openapi.yaml", import.meta.url),
    "utf8",
  ),
) as {
  paths: Record<string, Record<string, { operationId?: string }>>;
};

// Hono schreibt «:id», OpenAPI «{id}»; Middleware (ALL) gehört nicht in die Beschreibung
const ausDokument = Object.entries(doc.paths)
  .flatMap(([pfad, ops]) =>
    Object.keys(ops)
      .filter((m) => METHODEN.includes(m))
      .map((m) => `${m.toUpperCase()} ${pfad.replace(/\{(\w+)\}/g, ":$1")}`),
  )
  .sort();
// Hono listet eine Route einmal je Validator und Handler
const ausApp = [
  ...new Set(
    app.routes
      .filter((r) => r.method !== "ALL")
      .map((r) => `${r.method} ${r.path}`),
  ),
].sort();

describe("docs/api/openapi.yaml", () => {
  test("beschreibt genau die Routen der App", () => {
    expect(ausDokument).toEqual(ausApp);
  });

  test("jede Operation hat eine eindeutige operationId", () => {
    const ids = Object.values(doc.paths).flatMap((ops) =>
      Object.entries(ops)
        .filter(([m]) => METHODEN.includes(m))
        .map(([, op]) => op.operationId),
    );
    expect(ids.every((id) => typeof id === "string")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("jeder $ref zeigt auf einen vorhandenen Eintrag", () => {
    const text = readFileSync(
      new URL("../../../docs/api/openapi.yaml", import.meta.url),
      "utf8",
    );
    const fehlend = [...text.matchAll(/\$ref: ['"]?#\/([^'"\s]+)/g)]
      .map((m) => m[1])
      .filter((ref) => {
        let knoten: unknown = doc;
        for (const teil of ref.split("/")) {
          knoten = (knoten as Record<string, unknown> | undefined)?.[teil];
        }
        return knoten === undefined;
      });
    expect(fehlend).toEqual([]);
  });
});
