import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { eq } from "drizzle-orm";

import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { agentSessions, environments, issues, issueWorkspaces, services, subjects } from "../../src/db/schema.ts";
import { migrateDatabaseBackups, migrateIssueSessionStorage } from "../../src/workspace/issue-storage.ts";
import { backupsRoot, issueAgentRoot, issueRuntimeRoot, legacyIssueSessionRoot } from "../../src/workspace/state.ts";

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

test("moves managed Agent session files into issue storage and retains unknown legacy data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-issue-storage-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "dev")).limit(1);
    await database.db.insert(subjects).values({ subject: "tester" });
    const [service] = await database.db.insert(services).values({ key: "storage", name: "Storage" }).returning();
    const [managedIssue, blockedIssue] = await database.db.insert(issues).values([
      { key: "ISSUE-20260810-301", title: "Managed", type: "defect_fix", serviceId: service!.id, environmentId: environment!.id, reporterSubject: "tester" },
      { key: "ISSUE-20260810-302", title: "Blocked", type: "defect_fix", serviceId: service!.id, environmentId: environment!.id, reporterSubject: "tester" },
    ]).returning();
    await database.db.insert(issueWorkspaces).values([
      { issueId: managedIssue!.id, status: "ready" },
      { issueId: blockedIssue!.id, status: "ready" },
    ]);

    const managedLegacyRoot = legacyIssueSessionRoot(root, managedIssue!.key);
    const sessionName = "2026-08-10T00-00-00-000Z_session.jsonl";
    const sidecarName = "session.runtime.json";
    const sessionContent = "{\"type\":\"session\"}\n";
    const sidecarContent = "{\"issueId\":\"managed\"}\n";
    await mkdir(path.join(managedLegacyRoot, "runtime", "generated"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(managedLegacyRoot, sessionName), sessionContent, { mode: 0o600 });
    await writeFile(path.join(managedLegacyRoot, sidecarName), sidecarContent, { mode: 0o600 });
    await database.db.insert(agentSessions).values({
      issueId: managedIssue!.id,
      sessionFile: path.join(managedLegacyRoot, sessionName),
      workspacePath: path.join(managedLegacyRoot, "runtime"),
    });

    const blockedLegacyRoot = legacyIssueSessionRoot(root, blockedIssue!.key);
    await mkdir(blockedLegacyRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(blockedLegacyRoot, "blocked.jsonl"), sessionContent, { mode: 0o600 });
    await writeFile(path.join(blockedLegacyRoot, "notes.txt"), "preserve\n", { mode: 0o600 });
    await database.db.insert(agentSessions).values({
      issueId: blockedIssue!.id,
      sessionFile: path.join(blockedLegacyRoot, "blocked.jsonl"),
      workspacePath: path.join(blockedLegacyRoot, "runtime"),
    });

    const result = await migrateIssueSessionStorage(database.db, root);
    assert.deepEqual(result, {
      migrated: [managedIssue!.key],
      blocked: [{ issueKey: blockedIssue!.key, reason: "issue_storage_has_untracked_files" }],
    });

    const agentRoot = issueAgentRoot(root, managedIssue!.key);
    const migratedSession = path.join(agentRoot, sessionName);
    const migratedSidecar = path.join(agentRoot, sidecarName);
    assert.equal(sha256(await readFile(migratedSession)), sha256(sessionContent));
    assert.equal(sha256(await readFile(migratedSidecar)), sha256(sidecarContent));
    assert.equal((await stat(migratedSession)).mode & 0o777, 0o600);
    assert.equal((await stat(agentRoot)).mode & 0o777, 0o700);
    await assert.rejects(access(managedLegacyRoot));

    const [binding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, managedIssue!.id));
    assert.equal(binding!.sessionFile, migratedSession);
    assert.equal(binding!.workspacePath, issueRuntimeRoot(root, managedIssue!.key));
    assert.equal(await readFile(path.join(blockedLegacyRoot, "notes.txt"), "utf8"), "preserve\n");
    const [blockedBinding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, blockedIssue!.id));
    assert.equal(blockedBinding!.sessionFile, path.join(blockedLegacyRoot, "blocked.jsonl"));

    assert.deepEqual(await migrateIssueSessionStorage(database.db, root), {
      migrated: [],
      blocked: [{ issueKey: blockedIssue!.key, reason: "issue_storage_has_untracked_files" }],
    });

    const backupName = "issues.db.before-storage-test";
    await writeFile(path.join(root, backupName), "backup\n", { mode: 0o600 });
    assert.deepEqual(await migrateDatabaseBackups(root), [backupName]);
    assert.equal(await readFile(path.join(backupsRoot(root), backupName), "utf8"), "backup\n");
    assert.equal((await stat(path.join(backupsRoot(root), backupName))).mode & 0o777, 0o600);
    await assert.rejects(access(path.join(root, backupName)));
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
