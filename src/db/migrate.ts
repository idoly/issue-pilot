import { applicationConfig } from "../config.ts";
import { ApplicationStateLease } from "../state-lease.ts";
import { migrateDatabase } from "./bootstrap.ts";
import { openDatabase } from "./client.ts";

/** Migrations change the schema under any running process, so they require the same state lease as the server. */
export async function migrateStateDatabase(stateRoot: string, databaseFile: string): Promise<void> {
  const lease = new ApplicationStateLease(stateRoot);
  await lease.start();
  const failures: unknown[] = [];
  try {
    const database = openDatabase(databaseFile);
    try {
      await migrateDatabase(database);
    } catch (error) {
      failures.push(error);
    }
    // Cleanup failures join the migration failure instead of replacing it.
    try {
      database.close();
    } catch (error) {
      failures.push(error);
    }
  } catch (error) {
    failures.push(error);
  }
  await lease.close().catch((error: unknown) => failures.push(error));
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "database_migration_failed");
}

if (import.meta.main) await migrateStateDatabase(applicationConfig.stateRoot, applicationConfig.databaseFile);
