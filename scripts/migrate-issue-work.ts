import { chmod, lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { applicationConfig } from "../src/config.ts";
import { applyIssueWorkMigration, planIssueWorkMigration } from "../src/workspace/work-directory-migration.ts";
import { issueWorkDirectory } from "../src/workspace/state.ts";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false }, "state-root": { type: "string" } } });
const apply = values.apply;
const root = path.resolve(values["state-root"] ?? applicationConfig.stateRoot);
const databaseFile = path.join(root, applicationConfig.state.databaseFile);
const socketPath = path.join(root, "control", "project-tools.sock");
const server = createServer(socket => socket.destroy());
let locked = false;
let socketIdentity: { dev: bigint; ino: bigint } | undefined;
let database: DatabaseSync | undefined;
try {
  if (apply) {
    // Claim the same endpoint as the API. A running or starting API makes migration fail.
    // Never unlink an existing socket, including an unexplained stale socket.
    await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    locked = true;
    await chmod(socketPath, 0o600);
    const metadata = await lstat(socketPath, { bigint: true });
    socketIdentity = { dev: metadata.dev, ino: metadata.ino };
  }
  database = new DatabaseSync(databaseFile, { readOnly: !apply });
  const rows = database.prepare("SELECT id, key FROM issues ORDER BY key").all() as Array<{ id: string; key: string }>;
  const plan = await planIssueWorkMigration(root, rows.map(row => row.key));
  console.log(JSON.stringify({ operation: apply ? "apply" : "plan", issues: new Set(plan.map(entry => entry.issueKey)).size, entries: plan.length, moves: plan.map(entry => ({ issue: entry.issueKey, file: path.basename(entry.source) })) }));
  if (apply) {
    const record = path.join(root, "control", `work-migration-${Date.now()}.json`);
    await writeFile(record, JSON.stringify({ state: "planned", moves: plan }, null, 2), { mode: 0o600, flag: "wx" });
    await applyIssueWorkMigration(plan, async () => {
      database!.exec("BEGIN IMMEDIATE");
      try {
        const update = database!.prepare("UPDATE issue_pilot_sessions SET workspace_path = ?, updated_at = unixepoch() WHERE issue_id = ? AND workspace_path <> ?");
        for (const issue of rows) {
          const directory = issueWorkDirectory(root, issue.key);
          update.run(directory, issue.id, directory);
        }
        database!.exec("COMMIT");
      } catch (error) { database!.exec("ROLLBACK"); throw error; }
    });
    const completed = `${record}.complete`;
    try {
      await writeFile(completed, JSON.stringify({ state: "completed", completedAt: new Date().toISOString(), moves: plan }, null, 2), { mode: 0o600, flag: "wx" });
      await rename(completed, record);
    } catch (error) { throw new Error("issue_work_migration_committed_record_failed", { cause: error }); }
    console.log(JSON.stringify({ completed: true, entries: plan.length, record }));
  }
} finally {
  database?.close();
  if (locked && socketIdentity) {
    // net.Server closes its own Unix socket; avoid touching any successor's endpoint.
    const metadata = await lstat(socketPath, { bigint: true }).catch(() => undefined);
    if (metadata && (metadata.dev !== socketIdentity.dev || metadata.ino !== socketIdentity.ino)) throw new Error("migration_socket_identity_changed");
  }
  if (locked) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
