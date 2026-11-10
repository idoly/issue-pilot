import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, test } from "node:test";

import { eq } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { applicationConfig } from "../../src/config.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issues, issueWorkspaces, serviceDeployments, services, subjects } from "../../src/db/schema.ts";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

test("retains seed environment timestamps when startup does not change their values", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-bootstrap-stamps-"));
  directories.push(root);
  const file = join(root, "issues.db"),
    unchangedAt = new Date(2_000);
  const initial = await openApplicationDatabase(file);
  await initial.db.update(environments).set({ updatedAt: unchangedAt });
  await initial.close();
  const reopened = await openApplicationDatabase(file);
  try {
    assert.ok((await reopened.db.select().from(environments)).every((row) => row.updatedAt.getTime() === unchangedAt.getTime()));
  } finally {
    await reopened.close();
  }
});

test("keeps application paths and workspace defaults in the project configuration", () => {
  assert.equal(applicationConfig.databaseFile, join(applicationConfig.stateRoot, "issues.db"));
  assert.equal(basename(applicationConfig.stateRoot), "data");
  assert.equal(applicationConfig.parameters.workspaceHighWaterBytes, 20 * 1024 ** 3);
  assert.equal(applicationConfig.parameters.workspaceTargetBytes, 16 * 1024 ** 3);
  assert.equal(applicationConfig.http.host, "0.0.0.0");
  assert.equal(applicationConfig.webRoot, join(applicationConfig.stateRoot, "..", "src", "web", "dist"));
  assert.equal(applicationConfig.limits.sourceBrowser.fileBytes, 64 * 1024 * 1024);
  assert.equal(applicationConfig.limits.relatedIssues, 20);
  assert.deepEqual(applicationConfig.limits.agentImage, { fileBytes: 20 * 1024 * 1024, requestBytes: 40 * 1024 * 1024, files: 20 });
  assert.equal(applicationConfig.parameters.capabilityConnectionMs, 10_000);
  assert.equal("database" in applicationConfig.limits.capability, false);
  assert.equal("dms" in applicationConfig.defaults, false);
  assert.deepEqual(applicationConfig.limits.capability.dms, { databases: 20, firstHandshakeMs: 12_000, retryDelayMs: 1_000, maxRetryDelayMs: 5_000 });
  assert.equal(applicationConfig.state.sqliteBusyTimeoutMs, 5_000);
  assert.equal(applicationConfig.regional.timeZone, "Asia/Shanghai");
  assert.equal(applicationConfig.web.host, "0.0.0.0");
  assert.equal(applicationConfig.web.markdownCacheEntries, 512);
  assert.equal(applicationConfig.web.markdownCacheCharacters, 4 * 1024 * 1024);
});

test("restores interrupted and ready workspaces when the application database reopens", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-bootstrap-"));
  directories.push(root);
  const file = join(root, "issues.db");
  const initial = await openApplicationDatabase(file);
  try {
    const [environment] = await initial.db.select().from(environments);
    assert.ok(environment);
    await initial.db.update(subjects).set({ displayName: "Bootstrap renamed" }).where(eq(subjects.subject, issuePilotConfig.bootstrapUser.subject));
    await initial.db.insert(subjects).values({ subject: "owner", displayName: "Owner" });
    const [service] = await initial.db.insert(services).values({ key: "orders", name: "Orders" }).returning();
    assert.ok(service);
    await initial.db.insert(serviceDeployments).values({ serviceId: service.id, environmentId: environment.id, config: {} });
    const created = await initial.db
      .insert(issues)
      .values([
        { key: "ISSUE-20260809-001", title: "Interrupted", type: "defect_fix", status: "in_progress", serviceId: service.id, environmentId: environment.id, reporterSubject: "owner" },
        { key: "ISSUE-20260809-002", title: "Ready", type: "defect_fix", status: "in_progress", serviceId: service.id, environmentId: environment.id, reporterSubject: "owner" },
        { key: "ISSUE-20260809-003", title: "Preparing another round", type: "defect_fix", status: "pending", serviceId: service.id, environmentId: environment.id, reporterSubject: "owner" },
        {
          key: "ISSUE-20260809-004",
          title: "Historical failure",
          type: "defect_fix",
          status: "open",
          serviceId: service.id,
          environmentId: environment.id,
          reporterSubject: "owner",
          updatedAt: new Date(2_000),
        },
      ])
      .returning();
    await initial.db.insert(issueWorkspaces).values([
      { issueId: created[0]!.id, status: "running" },
      { issueId: created[1]!.id, status: "ready" },
      { issueId: created[2]!.id, status: "preparing" },
      { issueId: created[3]!.id, status: "failed", lastError: "fixture_failure", updatedAt: new Date(2_000) },
    ]);
  } finally {
    await initial.close();
  }

  const openedAt = Date.now();
  const reopened = await openApplicationDatabase(file);
  try {
    const recoveredIssues = Object.fromEntries((await reopened.db.select().from(issues)).map((issue) => [issue.key, issue]));
    assert.equal(recoveredIssues["ISSUE-20260809-001"]?.status, "open");
    assert.equal(recoveredIssues["ISSUE-20260809-002"]?.status, "pending");
    assert.equal(recoveredIssues["ISSUE-20260809-003"]?.status, "open");
    for (const key of ["ISSUE-20260809-001", "ISSUE-20260809-002", "ISSUE-20260809-003"]) {
      // Recovery timestamps are written during open, not before it.
      const issue = recoveredIssues[key]!;
      assert.ok(issue.updatedAt.getTime() >= openedAt - 1_000, issue.updatedAt.toISOString());
    }
    assert.equal(recoveredIssues["ISSUE-20260809-004"]?.updatedAt.getTime(), 2_000);
    const workspaces = Object.fromEntries((await reopened.db.select().from(issueWorkspaces)).map((workspace) => [workspace.issueId, workspace]));
    const interrupted = Object.values(workspaces).find((workspace) => workspace.issueId === recoveredIssues["ISSUE-20260809-001"]?.id);
    assert.equal(interrupted?.status, "failed");
    assert.equal(interrupted?.lastError, "agent_interrupted_by_api_restart");
    assert.ok(interrupted && interrupted.updatedAt.getTime() >= openedAt - 1_000, interrupted?.updatedAt.toISOString());
    const preparing = workspaces[recoveredIssues["ISSUE-20260809-003"]!.id];
    assert.equal(preparing?.status, "failed");
    assert.equal(preparing?.lastError, "agent_interrupted_by_api_restart");
    const historical = workspaces[recoveredIssues["ISSUE-20260809-004"]!.id];
    assert.equal(historical?.lastError, "fixture_failure");
    assert.equal(historical?.updatedAt.getTime(), 2_000);
    const [bootstrapUser] = await reopened.db.select().from(subjects).where(eq(subjects.subject, issuePilotConfig.bootstrapUser.subject));
    assert.equal(bootstrapUser?.displayName, "Bootstrap renamed");
    const configuredEnvironments = Object.fromEntries((await reopened.db.select().from(environments)).map((environment) => [environment.key, environment.name]));
    assert.deepEqual(configuredEnvironments, { prod: "正式", test: "测试", dev: "开发" });
  } finally {
    await reopened.close();
  }
});

test("reports a missing workspace in the explicit audit without preventing ordinary database startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-bootstrap-invalid-"));
  directories.push(root);
  const file = join(root, "issues.db");
  const initial = await openApplicationDatabase(file);
  try {
    const [environment] = await initial.db.select().from(environments).where(eq(environments.key, "test")).limit(1);
    await initial.db.insert(subjects).values({ subject: "owner", displayName: "Owner" });
    const [service] = await initial.db.insert(services).values({ key: "orders", name: "Orders" }).returning();
    await initial.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
    await initial.db
      .insert(issues)
      .values({ key: "ISSUE-20260809-003", title: "Missing workspace", type: "smart_analysis", serviceId: service!.id, environmentId: environment!.id, reporterSubject: "owner" });
  } finally {
    await initial.close();
  }

  const reopened = await openApplicationDatabase(file);
  await reopened.close();
  assert.throws(
    () => execFileSync(process.execPath, ["--experimental-strip-types", "scripts/check-issue-state.ts", "--state-root", root], { stdio: "pipe" }),
    /issue_workspace_missing:ISSUE-20260809-003/,
  );
});

test("closes the database client when bootstrap initialization fails", async () => {
  const failure = new Error("pragma_failed");
  let closed = false;
  const connect = () =>
    ({
      client: {
        execute: async () => {
          throw failure;
        },
      },
      db: {},
      close: async () => {
        closed = true;
      },
    }) as never;

  await assert.rejects(openApplicationDatabase("ignored.db", connect), (error) => error === failure);
  assert.equal(closed, true);
});
