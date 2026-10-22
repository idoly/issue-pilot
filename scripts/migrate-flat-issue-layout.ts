import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { applicationConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/client.ts";
import { migrateDatabase } from "../src/db/bootstrap.ts";
import { issueRepositoryWorkspaceNames } from "../src/workspace/git.ts";
import { applyFlatIssueLayout, planFlatIssueLayout, type FlatLayoutAttachment, type FlatLayoutIssue, type FlatLayoutSession } from "../src/workspace/flat-layout-migration.ts";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false }, "state-root": { type: "string" } } });
const root = path.resolve(values["state-root"] ?? applicationConfig.stateRoot), socketPath = path.join(root, "control", "project-tools.sock");
const lock = createServer(socket => socket.destroy());
let locked = false;
let socketIdentity: { dev: number; ino: number } | undefined;
let database: DatabaseSync | undefined;
try {
  if (values.apply) {
    await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    await new Promise<void>((resolve, reject) => { lock.once("error", reject); lock.listen(socketPath, resolve); });
    locked = true;
    const metadata = await lstat(socketPath);
    socketIdentity = { dev: metadata.dev, ino: metadata.ino };
    await chmod(socketPath, 0o600);
  }
  database = new DatabaseSync(path.join(root, applicationConfig.state.databaseFile), { readOnly: true });
  database.exec("PRAGMA foreign_keys=ON");
  const issues = database.prepare("SELECT id,key FROM issues ORDER BY key").all().map(row => {
    const repositories = database!.prepare("SELECT url,local_path AS localPath,workspace_name AS workspaceName FROM issue_repositories WHERE issue_id=?").all(row.id!) as unknown as Array<{ url: string; localPath: string | null; workspaceName: string | null }>;
    return { id: String(row.id), key: String(row.key), repositoryNames: [...issueRepositoryWorkspaceNames(repositories).values()] };
  }) as FlatLayoutIssue[];
  const hasWorkingName = database.prepare("PRAGMA table_info(issue_attachments)").all().some(row => row.name === "working_file_name");
  const attachments = database.prepare(`SELECT id,issue_id AS issueId,object_key AS objectKey,size,sha256,${hasWorkingName ? "working_file_name" : "NULL"} AS workingFileName FROM issue_attachments ORDER BY id`).all() as unknown as FlatLayoutAttachment[];
  const sessions = database.prepare("SELECT issue_id AS issueId,session_file AS sessionFile,workspace_path AS workspacePath FROM issue_pilot_sessions ORDER BY issue_id").all() as unknown as FlatLayoutSession[];
  const plan = await planFlatIssueLayout(root, issues, attachments, sessions);
  const summary = { issues: issues.length, fileMoves: plan.moves.filter(row => !row.duplicate).length, duplicateFilesReused: plan.moves.filter(row => row.duplicate).length, sessions: plan.sessions.length, attachments: plan.attachments.length, legacyOutputMappings: plan.manifests.length, generatedRuntimes: plan.generated.length };
  console.log(JSON.stringify({ operation: values.apply ? "apply" : "plan", ...summary }));
  if (values.apply) {
    const record = path.join(root, "control", `flat-layout-migration-${Date.now()}.json`);
    await writeFile(record, JSON.stringify({ state: "planned", summary, plan }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    database.close(); database = undefined;
    const connection = openDatabase(path.join(root, applicationConfig.state.databaseFile));
    try { await migrateDatabase(connection); } finally { await connection.close(); }
    database = new DatabaseSync(path.join(root, applicationConfig.state.databaseFile));
    database.exec("PRAGMA foreign_keys=ON");
    await applyFlatIssueLayout(plan, async changes => {
      database!.exec("BEGIN IMMEDIATE");
      try {
        const updateAttachment = database!.prepare("UPDATE issue_attachments SET object_key=?,working_file_name=? WHERE id=? AND object_key=?");
        for (const row of changes.attachments) {
          const old = attachments.find(old => old.id === row.id)!;
          if (updateAttachment.run(row.objectKey, row.workingFileName, row.id, old.objectKey).changes !== 1) throw new Error("flat_layout_attachment_changed");
        }
        const updateSession = database!.prepare("UPDATE issue_pilot_sessions SET session_file=?,workspace_path=?,updated_at=unixepoch() WHERE issue_id=? AND session_file=?");
        for (const row of changes.sessions) {
          const old = sessions.find(old => old.issueId === row.issueId)!;
          if (updateSession.run(row.sessionFile, row.workspacePath, row.issueId, old.sessionFile).changes !== 1) throw new Error("flat_layout_session_changed");
        }
        if (database!.prepare("PRAGMA foreign_key_check").all().length) throw new Error("flat_layout_foreign_key_failed");
        database!.exec("COMMIT");
      } catch (error) { database!.exec("ROLLBACK"); throw error; }
    }, path.join(root, "control", `flat-layout-quarantine-${Date.now()}`));
    await writeFile(record, JSON.stringify({ state: "completed", completedAt: new Date().toISOString(), summary, plan }, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ completed: true, ...summary }));
  }
} catch (error) {
  const message = error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE" ? "flat_layout_control_socket_in_use" : error instanceof Error && /^[a-z_]+(?::ISSUE-[0-9-]+(?:\/[^\s]+)?)?$/.test(error.message) ? error.message : "flat_layout_migration_failed";
  console.error(message); process.exitCode = 1;
} finally {
  database?.close();
  if (locked) {
    const metadata = await lstat(socketPath);
    if (!metadata.isSocket() || metadata.dev !== socketIdentity?.dev || metadata.ino !== socketIdentity.ino) throw new Error("flat_layout_socket_changed");
    await new Promise<void>((resolve, reject) => lock.close(error => error ? reject(error) : resolve()));
  }
}
