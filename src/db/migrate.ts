import { resolve } from "node:path";

import { migrate } from "drizzle-orm/libsql/migrator";

import { openDatabase } from "./client.ts";

const database = openDatabase();
try {
  await migrate(database.db, { migrationsFolder: resolve("drizzle") });
} finally {
  database.close();
}
