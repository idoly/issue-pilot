import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issues as issueRecords, issueWorkspaces, serviceDeployments, services } from "../../src/db/schema.ts";
import { prepareIssueRuntime, prepareIssueRuntimeBatch } from "../../src/workspace/runtime.ts";
import { issueRuntimeRoot, issueWorkspaceRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

test("bounds runtime preparation concurrency and preserves Issue result order", async () => {
  const issues = ["001", "002", "003", "004"].map((suffix) => ({ id: suffix, key: `ISSUE-20260816-${suffix}` }));
  let active = 0;
  let maximumActive = 0;
  let failedUpdates = 0;
  const database = {
    update() {
      failedUpdates += 1;
      return { set: () => ({ where: async () => undefined }) };
    },
  };
  const result = await prepareIssueRuntimeBatch(database as never, issues, async (issue) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, issue.id === "001" ? 15 : 2));
      if (issue.id === "002") throw new Error("runtime_blocked");
    } finally {
      active -= 1;
    }
  }, { concurrency: 2 });

  assert.equal(maximumActive, 2);
  assert.equal(failedUpdates, 1);
  assert.deepEqual(result, {
    prepared: ["ISSUE-20260816-001", "ISSUE-20260816-003", "ISSUE-20260816-004"],
    blocked: [{ issueKey: "ISSUE-20260816-002", reason: "runtime_blocked" }],
  });
});

test("keeps unchanged runtime timestamps across preparation failures and retries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-runtime-failure-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "dev")).limit(1);
    const [service] = await database.db.insert(services).values({ key: "runtime-failure", name: "Runtime failure" }).returning();
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
    const rows = await database.db.insert(issueRecords).values(["001", "002", "003"].map(suffix => ({ key: `ISSUE-20261018-${suffix}`, title: "Runtime retry", type: "defect_fix" as const, serviceId: service!.id, environmentId: environment!.id, reporterSubject: issuePilotConfig.bootstrapUser.subject }))).returning();
    const unchangedAt = new Date("2026-08-01T00:00:00Z");
    await database.db.insert(issueWorkspaces).values(rows.map((issue, index) => ({ issueId: issue.id, runtimeReady: index > 0, updatedAt: unchangedAt })));
    const prepare = async (issue: typeof rows[number]) => { if (issue.id !== rows[2]!.id) throw new Error("runtime_blocked"); };
    const first = await prepareIssueRuntimeBatch(database.db, rows, prepare);
    const firstStates = new Map((await database.db.select().from(issueWorkspaces)).map(row => [row.issueId, row]));
    assert.equal(firstStates.get(rows[0]!.id)!.updatedAt.getTime(), unchangedAt.getTime());
    assert.equal(firstStates.get(rows[1]!.id)!.runtimeReady, false);
    assert.notEqual(firstStates.get(rows[1]!.id)!.updatedAt.getTime(), unchangedAt.getTime());
    assert.equal(firstStates.get(rows[2]!.id)!.runtimeReady, true);
    const repeated = await prepareIssueRuntimeBatch(database.db, rows, prepare);
    assert.deepEqual(repeated, first);
    assert.deepEqual(first, { prepared: [rows[2]!.key], blocked: rows.slice(0, 2).map(issue => ({ issueKey: issue.key, reason: "runtime_blocked" })) });
    for (const workspace of await database.db.select().from(issueWorkspaces)) {
      assert.equal(workspace.updatedAt.getTime(), firstStates.get(workspace.issueId)!.updatedAt.getTime());
    }
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});

test("prepares the same issue runtime shape for read-only checkouts and writable worktrees", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-runtime-"));
  const readOnlyIssue = "ISSUE-20260810-001";
  const writableIssue = "ISSUE-20260810-002";
  try {
    const checkout = path.join(sharedCheckoutsRoot(root), "repository", "commit");
    await mkdir(checkout, { recursive: true });
    await writeFile(path.join(checkout, "README.md"), "shared checkout\n", "utf8");

    const readOnlyRuntime = await prepareIssueRuntime(root, readOnlyIssue, [{ name: "orders", repositoryPath: checkout }], "read");
    assert.equal(readOnlyRuntime, issueRuntimeRoot(root, readOnlyIssue));
    assert.equal((await lstat(path.join(readOnlyRuntime, "orders"))).isSymbolicLink(), true);
    const readOnlyLink = await readlink(path.join(readOnlyRuntime, "orders"));
    assert.equal(path.isAbsolute(readOnlyLink), false);
    assert.equal(path.resolve(readOnlyRuntime, readOnlyLink), checkout);
    assert.equal(await readFile(path.join(readOnlyRuntime, "orders", "README.md"), "utf8"), "shared checkout\n");
    assert.equal((await lstat(issueWorkspaceRoot(root, readOnlyIssue))).isDirectory(), true);

    const worktree = path.join(issueWorkspaceRoot(root, writableIssue), "orders");
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, "README.md"), "writable worktree\n", "utf8");
    const writableRuntime = await prepareIssueRuntime(root, writableIssue, [{ name: "orders", repositoryPath: worktree }], "write");
    assert.equal(writableRuntime, issueWorkspaceRoot(root, writableIssue));
    assert.equal((await lstat(path.join(writableRuntime, "orders"))).isDirectory(), true);
    await writeFile(path.join(writableRuntime, "orders", "created-through-runtime.txt"), "writable\n", "utf8");
    assert.equal(await readFile(path.join(worktree, "created-through-runtime.txt"), "utf8"), "writable\n");

    const relatedDirectory = issueWorkspaceRoot(root, "ISSUE-20260809-099");
    await mkdir(relatedDirectory, { recursive: true });
    const conversation = path.join(relatedDirectory, ".session-related.jsonl");
    await writeFile(conversation, "{\"type\":\"session\"}\n", "utf8");
    const relatedRuntime = await prepareIssueRuntime(root, readOnlyIssue, [{ name: "orders", repositoryPath: checkout }], "read", [{
      key: "ISSUE-20260809-099",
      metadata: { key: "ISSUE-20260809-099", title: "Earlier development" },
      conversationPath: conversation,
      workDirectory: relatedDirectory,
    }]);
    assert.deepEqual(JSON.parse(await readFile(path.join(relatedRuntime, ".related-issue-20260809-099.json"), "utf8")), { key: "ISSUE-20260809-099", title: "Earlier development" });
    assert.equal(await readFile(path.join(relatedRuntime, ".related-issue-20260809-099.jsonl"), "utf8"), "{\"type\":\"session\"}\n");
    assert.equal(await readlink(path.join(relatedRuntime, ".related-issue-20260809-099")), path.relative(relatedRuntime, relatedDirectory));

    await assert.rejects(
      prepareIssueRuntime(root, writableIssue, [{ name: "outside", repositoryPath: checkout }], "write"),
      /repository_workspace_outside_issue_root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
