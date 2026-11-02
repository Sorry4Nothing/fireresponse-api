import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client.js";
import { user } from "../db/schema.js";
import { EINWILLIGUNG_TEXT, EINWILLIGUNG_VERSION } from "../einwilligung.js";
import type { Person } from "../rechte.js";

// Auch in den Importen ohne node:* und process: Die App prüft diese Datei über AppType
export function erstelleEinwilligungRouten({ db }: { db: Db }) {
  return (
    new Hono<{ Variables: { person: Person } }>()
      .get("/", (c) => {
        const person = c.get("person");
        return c.json({
          version: EINWILLIGUNG_VERSION,
          text: EINWILLIGUNG_TEXT,
          gueltig: person.einwilligung,
        });
      })
      // Die Person kommt aus der Sitzung, nie aus dem Body; die Fassung setzt der Server, nicht die App
      .put("/", async (c) => {
        const person = c.get("person");
        await db
          .update(user)
          .set({
            einwilligungAm: new Date(),
            einwilligungVersion: EINWILLIGUNG_VERSION,
          })
          .where(eq(user.id, person.id));
        return c.body(null, 204);
      })
  );
}
