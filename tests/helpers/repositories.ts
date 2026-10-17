import type { Database } from "../../src/db/client.ts";
import { repositories } from "../../src/db/schema.ts";

export async function registerTestRepositories(database: Database, urls: string[]) {
  for (const url of new Set(urls)) await database.insert(repositories).values({ name: url, url }).onConflictDoNothing();
}
