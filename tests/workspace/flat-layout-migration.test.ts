import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { applyFlatIssueLayout, planFlatIssueLayout, type FlatLayoutAttachment, type FlatLayoutSession } from "../../src/workspace/flat-layout-migration.ts";
import { issueRoot, legacyIssueRoot } from "../../src/workspace/state.ts";
import { resolveIssueOutput } from "../../src/outputs/store.ts";
const key = "ISSUE-20261022-001", issue = { id: "issue", key, repositoryNames: [] };
async function fixture() {
  const state = await mkdtemp(path.join(tmpdir(), "issue-pilot-flat-layout-")), old = legacyIssueRoot(state, key), root = issueRoot(state, key);
  for (const directory of [root, path.join(old, "agent"), path.join(old, "attachments"), path.join(old, "outputs"), path.join(old, "runtime")]) await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(old, "agent", "session.jsonl"), JSON.stringify({ type: "session", id: "session-id", cwd: root }) + "\n", { mode: 0o600 });
  const original = path.join(old, "attachments", "uuid-image.png"); await writeFile(original, "original", { mode: 0o400 });
  await writeFile(path.join(root, "uuid-image.png"), "edited working copy", { mode: 0o600 });
  await writeFile(path.join(old, "outputs", "report.xlsx"), "delivered", { mode: 0o600 });
  await writeFile(path.join(root, "report.xlsx"), "working source", { mode: 0o600 });
  const attachments: FlatLayoutAttachment[] = [{ id: "attachment", issueId: "issue", objectKey: original, workingFileName: null, size: 8, sha256: createHash("sha256").update("original").digest("hex") }];
  const sessions: FlatLayoutSession[] = [{ issueId: "issue", sessionFile: path.join(old, "agent", "session.jsonl"), workspacePath: root }];
  return { state, old, root, attachments, sessions, async cleanup() { await rm(state, { recursive: true, force: true }); } };
}
test("flat migration preserves edited working files, original attachments, sessions and colliding old deliveries", async () => {
  const f = await fixture();
  try {
    const plan = await planFlatIssueLayout(f.state, [issue], f.attachments, f.sessions);
    await applyFlatIssueLayout(plan, async changes => {
      assert.equal(await readFile(changes.attachments[0]!.objectKey, "utf8"), "original");
      assert.equal((await stat(changes.attachments[0]!.objectKey)).mode & 0o777, 0o400);
      Object.assign(f.attachments[0]!, changes.attachments[0]); Object.assign(f.sessions[0]!, changes.sessions[0]);
    }, path.join(f.state, "control", "quarantine"));
    assert.equal(await readFile(path.join(f.root, "report.xlsx"), "utf8"), "working source");
    assert.equal(await readFile(await resolveIssueOutput(f.state, key, "report.xlsx"), "utf8"), "delivered");
    assert.equal(await readFile(path.join(f.root, "uuid-image.png"), "utf8"), "edited working copy");
    assert.equal(path.dirname(f.sessions[0]!.sessionFile), f.root); assert.equal(f.attachments[0]!.workingFileName, "uuid-image.png");
    await assert.rejects(stat(f.old), { code: "ENOENT" });
    const again = await planFlatIssueLayout(f.state, [issue], f.attachments, f.sessions); assert.deepEqual(again.moves, []);
  } finally { await f.cleanup(); }
});
test("a failed metadata commit rolls file and alias changes back and allows retry", async () => {
  const f = await fixture();
  try {
    const plan = await planFlatIssueLayout(f.state, [issue], f.attachments, f.sessions);
    await assert.rejects(applyFlatIssueLayout(plan, async () => { throw new Error("commit failed"); }, path.join(f.state, "control", "quarantine")), /commit failed/);
    assert.equal(await readFile(f.attachments[0]!.objectKey, "utf8"), "original");
    assert.equal(await readFile(path.join(f.old, "outputs", "report.xlsx"), "utf8"), "delivered");
    assert.deepEqual((await readdir(f.root)).sort(), ["report.xlsx", "uuid-image.png"]);
    assert.ok((await stat(path.join(f.old, "runtime"))).isDirectory());
    await applyFlatIssueLayout(await planFlatIssueLayout(f.state, [issue], f.attachments, f.sessions), async () => {}, path.join(f.state, "control", "retry"));
  } finally { await f.cleanup(); }
});
test("identical old deliveries reuse the working file without overwriting it", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, "report.xlsx"), "delivered"); const before = await stat(path.join(f.root, "report.xlsx"));
    const plan = await planFlatIssueLayout(f.state, [issue], f.attachments, f.sessions); assert.equal(plan.moves.filter(row => row.duplicate).length, 1);
    await applyFlatIssueLayout(plan, async () => {}, path.join(f.state, "control", "quarantine"));
    assert.equal((await stat(path.join(f.root, "report.xlsx"))).ino, before.ino);
    assert.equal(await resolveIssueOutput(f.state, key, "report.xlsx"), path.join(f.root, "report.xlsx"));
  } finally { await f.cleanup(); }
});
test("unknown old files, invalid attachments and runtime content are preserved for inspection", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.old, "unknown-directory"));
    await assert.rejects(planFlatIssueLayout(f.state, [issue], f.attachments, f.sessions), /flat_layout_unknown_issue_state/);
    await rm(path.join(f.old, "unknown-directory"), { recursive: true });
    await writeFile(path.join(f.old, "runtime", "unknown.txt"), "unknown");
    await assert.rejects(planFlatIssueLayout(f.state, [issue], f.attachments, f.sessions), /requires_inspection/);
    await rm(path.join(f.old, "runtime", "unknown.txt"));
    await chmod(f.attachments[0]!.objectKey, 0o600);
    await assert.rejects(planFlatIssueLayout(f.state, [issue], f.attachments, f.sessions), /attachment_integrity_failed/);
    assert.equal(await readFile(path.join(f.old, "outputs", "report.xlsx"), "utf8"), "delivered");
  } finally { await f.cleanup(); }
});
test("the migration rejects changed planned files before performing moves", async () => {
  const f = await fixture();
  try {
    const plan = await planFlatIssueLayout(f.state, [issue], f.attachments, f.sessions);
    await writeFile(path.join(f.old, "outputs", "report.xlsx"), "changed after plan");
    let committed = false;
    await assert.rejects(applyFlatIssueLayout(plan, async () => { committed = true; }, path.join(f.state, "control", "quarantine")), /source_changed/);
    assert.equal(committed, false); assert.ok(await stat(f.sessions[0]!.sessionFile));
  } finally { await f.cleanup(); }
});
test("runtime symlinks are inspected without traversing their repository targets", async () => {
  const f = await fixture();
  try {
    const repository = path.join(f.state, "git", "checkouts", "repository", "commit"); await mkdir(repository, { recursive: true });
    await writeFile(path.join(repository, "source.java"), "unchanged"); await symlink(repository, path.join(f.old, "runtime", "repo"));
    await applyFlatIssueLayout(await planFlatIssueLayout(f.state, [{ ...issue, repositoryNames: ["repo"] }], f.attachments, f.sessions), async () => {}, path.join(f.state, "control", "quarantine"));
    assert.equal(await readFile(path.join(repository, "source.java"), "utf8"), "unchanged");
  } finally { await f.cleanup(); }
});
