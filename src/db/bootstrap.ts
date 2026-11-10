import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { ENVIRONMENT_KINDS } from "../domain/contracts.ts";
import { openDatabase, type DatabaseConnection } from "./client.ts";
import { environments, subjects } from "./schema.ts";

export async function migrateDatabase(database: DatabaseConnection): Promise<void> {
  await migrate(database.db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}

async function recoverInterruptedIssues(database: DatabaseConnection): Promise<void> {
  // The partial Workspace index and Issue status index keep recovery proportional to interrupted work.
  // Apply both sides of the state change together; another crash must not leave a half-recovered round.
  await database.client.batch(
    [
      `UPDATE issues SET status = 'open', updated_at = unixepoch()
       WHERE id IN (SELECT issue_id FROM issue_workspaces WHERE status IN ('preparing', 'running'))
         AND status NOT IN ('resolved', 'open')`,
      `UPDATE issues AS i SET status = CASE w.status WHEN 'ready' THEN 'pending' ELSE 'open' END, updated_at = unixepoch()
       FROM issue_workspaces AS w WHERE i.status = 'in_progress' AND w.issue_id = i.id AND w.status IN ('ready', 'failed')`,
      `UPDATE issue_workspaces SET status = 'failed', last_error = coalesce(last_error, 'agent_interrupted_by_api_restart'), updated_at = unixepoch()
       WHERE status IN ('preparing', 'running')`,
    ],
    "write",
  );
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
      await database.db.insert(subjects).values({ subject: user.subject, displayName: user.name, email: user.email, role: user.role, isAdmin: user.isAdmin });
    }
    await recoverInterruptedIssues(database);

    for (const kind of ENVIRONMENT_KINDS) {
      const definition = { key: kind, name: issuePilotConfig.defaults.environments[kind], kind };
      const [existing] = await database.db.select().from(environments).where(eq(environments.key, kind)).limit(1);
      if (existing && (existing.name !== definition.name || existing.kind !== kind)) {
        await database.db.update(environments).set({ name: definition.name, kind, updatedAt: new Date() }).where(eq(environments.id, existing.id));
      } else if (!existing) {
        await database.db.insert(environments).values(definition);
      }
    }
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}
