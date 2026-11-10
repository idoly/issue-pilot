import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { applicationConfig } from "../src/config.ts";
import { assertIssueStateLayout } from "../src/workspace/state.ts";

const { values } = parseArgs({ options: { "state-root": { type: "string" } } });
const root = values["state-root"];
if (!root || !path.isAbsolute(root)) throw new Error("absolute_state_root_required");

const database = new DatabaseSync(path.join(root, applicationConfig.state.databaseFile), { readOnly: true });
try {
  const missing = database.prepare("SELECT i.key FROM issues AS i LEFT JOIN issue_workspaces AS w ON w.issue_id = i.id WHERE w.issue_id IS NULL LIMIT 1").get();
  if (missing) throw new Error(`issue_workspace_missing:${missing.key}`);
  const invalid = database.prepare("SELECT key FROM issues WHERE (status = 'resolved') <> (resolved_at IS NOT NULL) LIMIT 1").get();
  if (invalid) throw new Error(`issue_resolution_state_invalid:${invalid.key}`);
  const keys = database
    .prepare("SELECT key FROM issues")
    .all()
    .map(({ key }) => String(key));
  await assertIssueStateLayout(root, keys);
  console.log(`Checked ${keys.length} Issue records and directory ownership`);
} finally {
  database.close();
}
