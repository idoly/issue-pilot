import { parseArgs } from "node:util";
import path from "node:path";
import { applicationConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/client.ts";
import { migrateDatabase } from "../src/db/bootstrap.ts";
import { applyFileConfiguration } from "../src/configuration/file-configuration.ts";
import { ApplicationStateLease } from "../src/workspace/state-lease.ts";

const { values } = parseArgs({ options: { "state-root": { type: "string" }, apply: { type: "boolean", default: false } } });
if (!values.apply) throw new Error("usage: import-configuration.ts --state-root ROOT --apply (stop the application and create a verified backup first)");
const stateRoot = path.resolve(values["state-root"] ?? applicationConfig.stateRoot);
const lease = new ApplicationStateLease(stateRoot);
await lease.start();
try {
  const database = openDatabase(path.join(stateRoot, applicationConfig.state.databaseFile));
  try {
    await migrateDatabase(database);
    const result = await applyFileConfiguration(database.db, stateRoot);
    console.log(JSON.stringify({ imported: true, services: result.services, mcp: result.mcp, users: result.userSubjects?.length ?? 0, inputFilesChanged: false }));
  } finally { await database.close(); }
} catch {
  console.error("configuration_import_failed; input files were preserved");
  process.exitCode = 1;
} finally { await lease.close(); }
