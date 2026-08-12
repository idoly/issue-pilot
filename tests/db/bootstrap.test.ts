import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, test } from "node:test";

import { applicationConfig } from "../../src/config.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issues, issueWorkspaces, serviceDeployments, services, subjects } from "../../src/db/schema.ts";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

test("keeps application paths and workspace defaults in the project configuration", () => {
  assert.equal(applicationConfig.databaseFile, join(applicationConfig.stateRoot, "issues.db"));
  assert.equal(basename(applicationConfig.stateRoot), ".issue-pilot");
  assert.equal(applicationConfig.workspace.highWaterBytes, 20 * 1024 ** 3);
  assert.equal(applicationConfig.workspace.targetBytes, 16 * 1024 ** 3);
  assert.equal(applicationConfig.runtime.codeServer.publicUrl, `http://${applicationConfig.runtime.codeServer.listenHost}:${applicationConfig.runtime.codeServer.listenPort}/`);
  assert.equal(applicationConfig.limits.capability.connectionMs, 10_000);
  assert.equal(applicationConfig.state.sqliteBusyTimeoutMs, 5_000);
  assert.equal(applicationConfig.regional.timeZone, "Asia/Shanghai");
  assert.equal(applicationConfig.web.host, "0.0.0.0");
});

test("restores interrupted and ready workspaces when the application database reopens", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-bootstrap-"));
  directories.push(root);
  const file = join(root, "issues.db");
  const initial = await openApplicationDatabase(file);
  try {
    const [environment] = await initial.db.select().from(environments);
    assert.ok(environment);
    await initial.db.insert(subjects).values({ subject: "owner", displayName: "Owner" });
    const [service] = await initial.db.insert(services).values({ key: "orders", name: "Orders" }).returning();
    assert.ok(service);
    await initial.db.insert(serviceDeployments).values({ serviceId: service.id, environmentId: environment.id, config: {} });
    const created = await initial.db.insert(issues).values([
      { key: "ISSUE-20260809-001", title: "Interrupted", status: "in_progress", serviceId: service.id, environmentId: environment.id, reporterSubject: "owner" },
      { key: "ISSUE-20260809-002", title: "Ready", status: "in_progress", serviceId: service.id, environmentId: environment.id, reporterSubject: "owner" },
    ]).returning();
    await initial.db.insert(issueWorkspaces).values([
      { issueId: created[0]!.id, status: "running" },
      { issueId: created[1]!.id, status: "ready" },
    ]);
  } finally {
    await initial.close();
  }

  const reopened = await openApplicationDatabase(file);
  try {
    const recoveredIssues = Object.fromEntries((await reopened.db.select().from(issues)).map((issue) => [issue.key, issue]));
    assert.equal(recoveredIssues["ISSUE-20260809-001"]?.status, "open");
    assert.equal(recoveredIssues["ISSUE-20260809-002"]?.status, "pending");
    const workspaces = Object.fromEntries((await reopened.db.select().from(issueWorkspaces)).map((workspace) => [workspace.issueId, workspace]));
    const interrupted = Object.values(workspaces).find((workspace) => workspace.issueId === recoveredIssues["ISSUE-20260809-001"]?.id);
    assert.equal(interrupted?.status, "failed");
    assert.equal(interrupted?.lastError, "agent_interrupted_by_api_restart");
    const configuredEnvironments = Object.fromEntries((await reopened.db.select().from(environments)).map((environment) => [environment.key, environment.name]));
    assert.deepEqual(configuredEnvironments, { prod: "正式", test: "测试", dev: "开发" });
  } finally {
    await reopened.close();
  }
});

test("closes the database client when bootstrap initialization fails", async () => {
  const failure = new Error("pragma_failed");
  let closed = false;
  const connect = () => ({
    client: { execute: async () => { throw failure; } },
    db: {},
    close: async () => { closed = true; },
  }) as never;

  await assert.rejects(openApplicationDatabase("ignored.db", connect), (error) => error === failure);
  assert.equal(closed, true);
});
