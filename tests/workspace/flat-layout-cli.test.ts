import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { test } from "node:test";
import { createApiFixture, createIssue, createService } from "../http/fixture.ts";
import { issueRoot, legacyIssueRoot } from "../../src/workspace/state.ts";
const execute = promisify(execFile);

test("the offline CLI upgrades a previous database and moves durable files, then safely repeats", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Migration", ["prod"]);
    const created = await createIssue(fixture.app, "migration", "prod", "Previous layout");
    const args = ["--experimental-strip-types", "scripts/migrate-flat-issue-layout.ts", "--state-root", fixture.root];
    fixture.engine.running.clear();
    await assert.rejects(execute(process.execPath, [...args, "--apply"]), error => error instanceof Error && "stderr" in error && /flat_layout_control_socket_in_use/.test(String(error.stderr)));
    await fixture.stop();
    const key = String(created.id), old = legacyIssueRoot(fixture.root, key), root = issueRoot(fixture.root, key);
    for (const name of ["agent", "attachments", "outputs", "runtime/bin", "work"]) await mkdir(path.join(old, name), { recursive: true, mode: 0o700 });
    const session = path.join(old, "agent", "original.jsonl"), original = path.join(old, "attachments", "upload.txt");
    const conversation = JSON.stringify({ type: "session", id: "preserved-session", cwd: root }) + "\n";
    await writeFile(session, conversation, { mode: 0o600 }); await writeFile(original, "original", { mode: 0o400 });
    await writeFile(path.join(old, "work", "checkpoint.json"), "{\"preserved\":true}", { mode: 0o600 });
    await writeFile(path.join(root, "upload.txt"), "edited working copy");
    await writeFile(path.join(root, "report.csv"), "working source"); await writeFile(path.join(old, "outputs", "report.csv"), "delivery");
    const wrapper = "#!/bin/sh\nset -eu\nruntime_bin=legacy\n# preserve this exact historical file\n";
    await writeFile(path.join(old, "runtime", "bin", "node-project"), wrapper, { mode: 0o700 });
    const journal = JSON.parse(await readFile(path.resolve("drizzle/meta/_journal.json"), "utf8"));
    const before = new DatabaseSync(fixture.databaseFile);
    try {
      before.exec("DROP TABLE user_preferences; DROP TABLE application_settings; ALTER TABLE mcp_services DROP COLUMN deployment_id; ALTER TABLE subjects DROP COLUMN revision; ALTER TABLE services DROP COLUMN revision; ALTER TABLE repositories DROP COLUMN revision; ALTER TABLE user_credentials DROP COLUMN revision;");
      before.exec("PRAGMA foreign_keys=ON; DROP TRIGGER issues_retired_type_insert; DROP TRIGGER issues_retired_type_update; DROP TRIGGER scope_transitions_retired_mode_insert; DROP TRIGGER scope_transitions_retired_mode_update; ALTER TABLE issue_attachments DROP COLUMN working_file_name;");
      before.prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?").run(journal.entries.find((entry: { tag: string }) => entry.tag === "0061_flat_issue_attachment_names").when);
      const issue = before.prepare("SELECT id,reporter_subject FROM issues WHERE key=?").get(key)!;
      before.prepare("UPDATE issues SET type='data_processing' WHERE id=?").run(issue.id!);
      before.prepare("INSERT INTO issue_pilot_sessions(issue_id,session_file,workspace_path,created_at,updated_at) VALUES(?,?,?,?,?)").run(issue.id!, session, root, 1, 1);
      before.prepare("INSERT INTO issue_attachments(id,issue_id,file_name,media_type,size,object_key,sha256,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run("attachment", issue.id!, "input.txt", "text/plain", 8, original, createHash("sha256").update("original").digest("hex"), issue.reporter_subject!, 1);
    } finally { before.close(); }
    await execute(process.execPath, args);
    assert.equal(await readFile(original, "utf8"), "original");
    assert.equal(await readFile(path.join(old, "work", "checkpoint.json"), "utf8"), "{\"preserved\":true}");
    await execute(process.execPath, [...args, "--apply"]);
    const after = new DatabaseSync(fixture.databaseFile, { readOnly: true });
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
    } finally { after.close(); }
    assert.equal((await stat(path.join(root, "checkpoint.json"))).mode & 0o777, 0o600);
    assert.equal(await readFile(path.join(root, "checkpoint.json"), "utf8"), "{\"preserved\":true}");
    assert.equal(await readFile(path.join(root, "report.csv"), "utf8"), "working source");
    const preservedOutputs = JSON.parse(await readFile(path.join(root, ".legacy-output-links.json"), "utf8")).files;
    assert.equal(await readFile(path.join(root, preservedOutputs["report.csv"]), "utf8"), "delivery");
    const preserved = (await readdir(root)).find(name => name.startsWith(".runtime-legacy-") && name.endsWith("node-project"));
    assert.ok(preserved); assert.equal(await readFile(path.join(root, preserved), "utf8"), wrapper);
    const repeated = await execute(process.execPath, [...args, "--apply"]);
    assert.equal(JSON.parse(repeated.stdout.split("\n")[0]!).fileMoves, 0);
  } finally { await fixture.cleanup(); }
});
