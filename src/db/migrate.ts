import { migrateDatabase } from "./bootstrap.ts";
import { openDatabase } from "./client.ts";

const database = openDatabase();
try {
  await migrateDatabase(database);
} finally {
  await database.close();
}
