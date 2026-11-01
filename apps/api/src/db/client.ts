import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import * as schema from "./schema.js";

// Ohne node:* und process: Routen importieren diese Datei, und die App prüft deren Importe über AppType
export const erstelleDb = (sql: Sql) => drizzle(sql, { schema });

export type Db = ReturnType<typeof erstelleDb>;
