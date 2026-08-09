import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";

import { ENVIRONMENT_KINDS, type EnvironmentKind } from "../domain/contracts.ts";
import { openDatabase } from "./client.ts";
import { environments } from "./schema.ts";

type OpenDatabase = ReturnType<typeof openDatabase>;

export async function migrateDatabase(database: OpenDatabase): Promise<void> {
  await migrate(database.db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}

export async function openApplicationDatabase(file?: string, connect: typeof openDatabase = openDatabase): Promise<OpenDatabase> {
  const database = connect(file);
  try {
    await database.client.execute("PRAGMA busy_timeout = 5000");
    await database.client.execute("PRAGMA journal_mode = WAL");
    await migrateDatabase(database);
    await database.client.execute("PRAGMA foreign_keys = ON");
    await database.client.execute({
      sql: "UPDATE issues SET status = 'open', updated_at = unixepoch() * 1000 WHERE status != 'resolved' AND id IN (SELECT issue_id FROM issue_workspaces WHERE status IN ('preparing', 'running', 'failed'))",
      args: [],
    });
    await database.client.execute({
      sql: "UPDATE issue_workspaces SET status = 'failed', last_error = coalesce(last_error, 'agent_interrupted_by_api_restart'), updated_at = unixepoch() * 1000 WHERE status IN ('preparing', 'running')",
      args: [],
    });
    await database.client.execute({
      sql: "UPDATE issues SET status = 'pending', updated_at = unixepoch() * 1000 WHERE status = 'in_progress' AND id IN (SELECT issue_id FROM issue_workspaces WHERE status = 'ready')",
      args: [],
    });

    const names: Record<EnvironmentKind, string> = { prod: "正式", test: "测试", dev: "开发" };
    for (const kind of ENVIRONMENT_KINDS) {
      const definition = { key: kind, name: names[kind], kind };
      const [existing] = await database.db.select().from(environments).where(eq(environments.key, kind)).limit(1);
      if (existing) {
        await database.db.update(environments).set({ name: definition.name, kind, updatedAt: new Date() }).where(eq(environments.id, existing.id));
      } else {
        await database.db.insert(environments).values(definition);
      }
    }
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}
