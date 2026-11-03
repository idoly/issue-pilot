import { applicationConfig } from "../config.ts";
import { ApplicationStateLease } from "../workspace/state-lease.ts";
import { migrateDatabase } from "./bootstrap.ts";
import { openDatabase } from "./client.ts";

/** Migrations change the schema under any running process, so they require the same state lease as the server. */
export async function migrateStateDatabase(stateRoot: string, databaseFile: string): Promise<void> {
  const lease = new ApplicationStateLease(stateRoot);
  await lease.start();
  try {
    const database = openDatabase(databaseFile);
    try {
      await migrateDatabase(database);
    } finally {
      await database.close();
    }
  } finally {
    await lease.close();
  }
}

if (import.meta.main) await migrateStateDatabase(applicationConfig.stateRoot, applicationConfig.databaseFile);
