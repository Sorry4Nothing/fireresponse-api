import { testClient } from "hono/testing";
import postgres from "postgres";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import { eingabe } from "../src/eingabe.js";
import { ladeSeiten } from "../src/seiten.js";
import { erstelleTestAuth } from "./hilfen/auth.js";

// Nie verbunden: Die Eingabeprüfung braucht keine Datenbank
const sql = postgres("postgres://postgres@127.0.0.1:1/fireresponse");
const db = erstelleDb(sql);
const auth = erstelleTestAuth(db);
afterAll(() => sql.end());

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Wie eine spätere Route, nur unter /api/ statt /api/v1/, wo personAusSitzung eine Sitzung verlangt; abteilung_id kommt aus der Sitzung, nie aus der Eingabe
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  seiten: ladeSeiten(),
}).post(
  "/api/test",
  eingabe("json", z.strictObject({ titel: z.string().max(20) })),
  (c) => c.json(c.req.valid("json")),
);

test("gültige Eingabe: 200, und der Client kennt das Schema", async () => {
  const client = testClient(app);
  const res = await client.api.test.$post({
    json: { titel: "Waldweihnacht" },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ titel: "Waldweihnacht" });
  // @ts-expect-error titel ist Text
  const falsch = await client.api.test.$post({ json: { titel: 1 } });
  expect(falsch.status).toBe(400);
});

test.each([
  [
    "abteilung_id",
    JSON.stringify({
      titel: "Waldweihnacht",
      abteilung_id: "00000000-0000-0000-0000-000000000001",
    }),
  ],
  ["zu langer Wert", JSON.stringify({ titel: "x".repeat(21) })],
  ["kaputtes JSON", '{"titel":'],
])("%s: 400 ohne Details von zod", async (_, body) => {
  const res = await app.request("/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    code: "UNGUELTIGE_EINGABE",
    message: "Ungültige Eingabe",
  });
});

test.each([
  ["z.object()", z.object({ titel: z.string() })],
  ["z.looseObject()", z.looseObject({ titel: z.string() })],
])("%s: eingabe() wirft schon beim Definieren", (_, schema) => {
  expect(() => eingabe("json", schema)).toThrow(
    "eingabe() braucht ein striktes Schema: z.strictObject() oder .strict()",
  );
});

test(".strict() genügt", () => {
  expect(() =>
    eingabe("json", z.object({ titel: z.string() }).strict()),
  ).not.toThrow();
});
