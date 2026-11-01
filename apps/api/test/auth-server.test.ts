import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";
import { erstelleApp } from "../src/app.js";
import { erstelleDb } from "../src/db/client.js";
import { ladeSeiten } from "../src/seiten.js";
import { APP, bereiteAuthTestsVor, erstelleTestAuth } from "./hilfen/auth.js";
import { API_URL } from "./hilfen/datenbank.js";
import {
  erstelleWelt,
  legePersonaAn,
  type PersonaKonto,
} from "./hilfen/personas.js";

// Vor dem Stub gesichert: Die Attrappe aus bereiteAuthTestsVor wirft bei jeder URL ausser HIBP
const echteFetch = globalThis.fetch;
bereiteAuthTestsVor();

const sql = postgres(API_URL);
const db = erstelleDb(sql);
const auth = erstelleTestAuth(db);
const app = erstelleApp({
  appMinVersion: "1.2.0",
  sql,
  db,
  auth,
  seiten: ladeSeiten(),
});

let server: ReturnType<typeof serve>;
let port: number;
let konto: PersonaKonto;

beforeAll(async () => {
  konto = await legePersonaAn(await erstelleWelt(db, auth), "elternA");
  port = await new Promise<number>((bereit) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info: AddressInfo) =>
      bereit(info.port),
    );
  });
});

afterAll(async () => {
  await new Promise((zu) => server.close(zu));
  await sql.end();
});

let ausgabe: MockInstance<typeof console.log>;
beforeEach(() => {
  ausgabe = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => ausgabe.mockRestore());

// Sonde, kein Ersatz für die Hono-Tests: Der Umbau in mitExpoOrigin muss Body und Cookie durch @hono/node-server und bodyLimit erhalten
test("POST sign-in/username über den echten Server: 200 mit Session-Cookie", async () => {
  const antwort = await echteFetch(
    `http://127.0.0.1:${port}/api/auth/sign-in/username`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "expo-origin": APP,
        cookie: konto.headers.cookie,
      },
      body: JSON.stringify({
        username: konto.benutzername,
        password: konto.passwort,
      }),
    },
  );
  expect(antwort.status).toBe(200);
  expect(antwort.headers.getSetCookie().join("; ")).toContain("session_token");
});
