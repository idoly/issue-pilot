import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/libsql/migrator";

import { openDatabase } from "./client.ts";

const database = openDatabase();
try {
  await migrate(database.db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
} finally {
  database.close();
}
