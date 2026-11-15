import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { test } from "node:test";
import { applicationConfig } from "../../src/config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { ApplicationStateLease } from "../../src/state-lease.ts";
import { issueRoot, legacyIssueRoot } from "../../src/workspace/state.ts";
import { migrateBefore } from "../db/migration-fixture.ts";
const execute = promisify(execFile);

test("the offline CLI upgrades a previous database and moves durable files, then safely repeats", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "issue-pilot-flat-"));
  const databaseFile = path.join(stateRoot, applicationConfig.state.databaseFile);
  try {
    const args = ["--experimental-strip-types", "scripts/migrate-flat-issue-layout.ts", "--state-root", stateRoot];
    const key = "ISSUE-20261115-001",
      old = legacyIssueRoot(stateRoot, key),
      root = issueRoot(stateRoot, key);
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const name of ["agent", "attachments", "outputs", "runtime/bin", "work"]) await mkdir(path.join(old, name), { recursive: true, mode: 0o700 });
    const session = path.join(old, "agent", "original.jsonl"),
      original = path.join(old, "attachments", "upload.txt");
    const conversation = JSON.stringify({ type: "session", id: "preserved-session", cwd: root }) + "\n";
    await writeFile(session, conversation, { mode: 0o600 });
    await writeFile(original, "original", { mode: 0o400 });
    await writeFile(path.join(old, "work", "checkpoint.json"), '{"preserved":true}', { mode: 0o600 });
    await writeFile(path.join(root, "upload.txt"), "edited working copy");
    await writeFile(path.join(root, "report.csv"), "working source");
    await writeFile(path.join(old, "outputs", "report.csv"), "delivery");
    const wrapper = "#!/bin/sh\nset -eu\nruntime_bin=legacy\n# preserve this exact historical file\n";
    await writeFile(path.join(old, "runtime", "bin", "node-project"), wrapper, { mode: 0o700 });
    const before = openDatabase(databaseFile);
    try {
      await migrateBefore(before, path.join(stateRoot, "migrations"), "0061_flat_issue_attachment_names");
      await before.client.execute("PRAGMA foreign_keys = ON");
      await before.client.batch(
        [
          "INSERT INTO subjects (subject, role, active, created_at, updated_at) VALUES ('owner', 'developer', 1, 1, 1)",
          "INSERT INTO environments (id, key, name, kind, created_at, updated_at) VALUES ('env', 'prod', 'Prod', 'prod', 1, 1)",
          "INSERT INTO services (id, key, name, created_at, updated_at) VALUES ('service', 'migration', 'Migration', 1, 1)",
          "INSERT INTO service_deployments (id, service_id, environment_id, config, created_at, updated_at) VALUES ('deployment', 'service', 'env', '{}', 1, 1)",
          {
            sql: "INSERT INTO issues (id, key, title, type, service_id, environment_id, reporter_subject, created_at, updated_at) VALUES ('issue', ?, 'Previous layout', 'data_processing', 'service', 'env', 'owner', 1, 1)",
            args: [key],
          },
          "INSERT INTO issue_workspaces (issue_id, created_at, updated_at) VALUES ('issue', 1, 1)",
          { sql: "INSERT INTO issue_pilot_sessions (issue_id, session_file, workspace_path, created_at, updated_at) VALUES ('issue', ?, ?, 1, 1)", args: [session, root] },
          {
            sql: "INSERT INTO issue_attachments (id, issue_id, file_name, media_type, size, object_key, sha256, uploaded_by, created_at) VALUES ('attachment', 'issue', 'input.txt', 'text/plain', 8, ?, ?, 'owner', 1)",
            args: [original, createHash("sha256").update("original").digest("hex")],
          },
        ],
        "write",
      );
    } finally {
      before.close();
    }
    const lease = new ApplicationStateLease(stateRoot);
    await lease.start();
    try {
      await assert.rejects(execute(process.execPath, [...args, "--apply"]), (error) => error instanceof Error && "stderr" in error && /flat_layout_control_socket_in_use/.test(String(error.stderr)));
    } finally {
      await lease.close();
    }
    await execute(process.execPath, args);
    assert.equal(await readFile(original, "utf8"), "original");
    assert.equal(await readFile(path.join(old, "work", "checkpoint.json"), "utf8"), '{"preserved":true}');
    await execute(process.execPath, [...args, "--apply"]);
    const after = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      assert.equal(after.prepare("SELECT type FROM issues WHERE key=?").get(key)!.type, "smart_analysis");
      const attachment = after.prepare("SELECT object_key,working_file_name FROM issue_attachments").get()!;
      assert.equal(path.dirname(String(attachment.object_key)), root);
      assert.equal((await stat(String(attachment.object_key))).mode & 0o777, 0o400);
      assert.equal(await readFile(String(attachment.object_key), "utf8"), "original");
      assert.equal(await readFile(path.join(root, String(attachment.working_file_name)), "utf8"), "edited working copy");
      assert.equal(await readFile(String(after.prepare("SELECT session_file FROM issue_pilot_sessions").get()!.session_file), "utf8"), conversation);
      assert.equal(after.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
      assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      after.close();
    }
    assert.equal((await stat(path.join(root, "checkpoint.json"))).mode & 0o777, 0o600);
    assert.equal(await readFile(path.join(root, "checkpoint.json"), "utf8"), '{"preserved":true}');
    assert.equal(await readFile(path.join(root, "report.csv"), "utf8"), "working source");
    const preservedOutputs = JSON.parse(await readFile(path.join(root, ".legacy-output-links.json"), "utf8")).files;
    assert.equal(await readFile(path.join(root, preservedOutputs["report.csv"]), "utf8"), "delivery");
    const preserved = (await readdir(root)).find((name) => name.startsWith(".runtime-legacy-") && name.endsWith("node-project"));
    assert.ok(preserved);
    assert.equal(await readFile(path.join(root, preserved), "utf8"), wrapper);
    const repeated = await execute(process.execPath, [...args, "--apply"]);
    assert.equal(JSON.parse(repeated.stdout.split("\n")[0]!).fileMoves, 0);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
