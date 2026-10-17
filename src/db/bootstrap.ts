import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { ENVIRONMENT_KINDS } from "../domain/contracts.ts";
import { openDatabase, type DatabaseConnection } from "./client.ts";
import { environments, subjects } from "./schema.ts";

async function assertIssueStructure(database: DatabaseConnection): Promise<void> {
  const tableRows = await database.client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('issues', 'issue_workspaces')");
  const tables = new Set(tableRows.rows.map((row) => row.name));
  if (!tables.has("issues")) return;
  if (!tables.has("issue_workspaces")) throw new Error("issue_workspaces_table_missing");
  const [issueWithoutWorkspace] = (await database.client.execute({
    sql: "SELECT issues.key FROM issues LEFT JOIN issue_workspaces ON issue_workspaces.issue_id = issues.id WHERE issue_workspaces.issue_id IS NULL LIMIT 1",
    args: [],
  })).rows;
  if (issueWithoutWorkspace) throw new Error(`issue_workspace_missing:${issueWithoutWorkspace.key}`);
  const [invalidResolution] = (await database.client.execute({
    sql: "SELECT key FROM issues WHERE (status = 'resolved') <> (resolved_at IS NOT NULL) LIMIT 1",
    args: [],
  })).rows;
  if (invalidResolution) throw new Error(`issue_resolution_state_invalid:${invalidResolution.key}`);
}

export async function migrateDatabase(database: DatabaseConnection): Promise<void> {
  await assertIssueStructure(database);
  await migrate(database.db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await assertIssueStructure(database);
}

export async function openApplicationDatabase(file?: string, connect: typeof openDatabase = openDatabase): Promise<DatabaseConnection> {
  const database = connect(file);
  try {
    await database.client.execute("PRAGMA journal_mode = WAL");
    await migrateDatabase(database);
    await database.client.execute("PRAGMA foreign_keys = ON");
    const [existingSubject] = await database.db.select({ subject: subjects.subject }).from(subjects).limit(1);
    if (!existingSubject) {
      const user = issuePilotConfig.bootstrapUser;
      await database.db.insert(subjects).values({ subject: user.subject, displayName: user.name, email: user.email, role: user.role });
    }
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

    for (const kind of ENVIRONMENT_KINDS) {
      const definition = { key: kind, name: issuePilotConfig.defaults.environments[kind], kind };
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
