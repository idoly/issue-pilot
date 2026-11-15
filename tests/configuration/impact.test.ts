import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";

import {
  issuesAffectedByCapabilityChange,
  issuesAffectedByGlobalChange,
  issuesAffectedByRepositoryChange,
  issuesAffectedByServiceChange,
  issuesAffectedByUserChange,
} from "../../src/configuration/impact.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issues, issueServiceScopes, repositories, serviceDeployments, serviceRepositories, services, subjects } from "../../src/db/schema.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { EnvironmentKind, StoredDeploymentConfig } from "../../src/domain/contracts.ts";

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-impact-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  t.after(async () => {
    await database.close();
    await rm(root, { recursive: true, force: true });
  });
  const db = database.db;
  // Development is identified by kind; a renamed key must not change impact.
  await db.update(environments).set({ key: "development" }).where(eq(environments.kind, "dev"));
  const environmentIds = Object.fromEntries((await db.select().from(environments)).map((row) => [row.kind, row.id])) as Record<EnvironmentKind, string>;
  const reporter = issuePilotConfig.bootstrapUser.subject;
  await db.insert(subjects).values({ subject: "assignee", role: "developer" });
  await db.insert(services).values([
    { id: "orders", key: "orders", name: "Orders" },
    { id: "billing", key: "billing", name: "Billing" },
  ]);
  const deploy = (id: string, serviceId: string, kind: EnvironmentKind, config: StoredDeploymentConfig = {}) => ({ id, serviceId, environmentId: environmentIds[kind], config });
  await db
    .insert(serviceDeployments)
    .values([
      deploy("orders-prod", "orders", "prod", { dms: { databases: [] } }),
      deploy("billing-test", "billing", "test"),
      deploy("billing-prod", "billing", "prod"),
      deploy("billing-dev", "billing", "dev"),
    ]);
  await db.insert(repositories).values([{ name: "orders", url: "file:///orders.git" }]);
  await db.insert(serviceRepositories).values({ serviceId: "orders", alias: "orders", url: "file:///orders.git" });
  let sequence = 0;
  const issue = (id: string, serviceId: string, kind: EnvironmentKind, assigneeSubject: string | null = null) => ({
    id,
    key: `ISSUE-20260101-${String(++sequence).padStart(3, "0")}`,
    title: id,
    type: kind === "dev" ? ("defect_fix" as const) : ("smart_analysis" as const),
    serviceId,
    environmentId: environmentIds[kind],
    reporterSubject: reporter,
    assigneeSubject,
  });
  await db
    .insert(issues)
    .values([
      issue("orders-prod-issue", "orders", "prod", "assignee"),
      issue("billing-test-issue", "billing", "test"),
      issue("billing-prod-issue", "billing", "prod"),
      issue("billing-dev-issue", "billing", "dev"),
    ]);
  await db.insert(issueServiceScopes).values({ issueId: "billing-prod-issue", serviceId: "orders" });
  return db;
}

const ids = (rows: Array<{ id: string }>) => rows.map(({ id }) => id).sort();

test("service changes reach every Issue in deployed or added environments plus development Issues", async (t) => {
  const db = await fixture(t);
  assert.deepEqual(ids(await issuesAffectedByServiceChange(db, "orders")), ["billing-dev-issue", "billing-prod-issue", "orders-prod-issue"]);
  assert.deepEqual(ids(await issuesAffectedByServiceChange(db, "orders", { environmentKeys: ["test"], dbHubChanged: false })), [
    "billing-dev-issue",
    "billing-prod-issue",
    "billing-test-issue",
    "orders-prod-issue",
  ]);
  assert.deepEqual(ids(await issuesAffectedByServiceChange(db, "new-service")), ["billing-dev-issue"]);
  assert.equal((await issuesAffectedByServiceChange(db, "orders", { dbHubChanged: true })).length, 4);
});

test("existing DBHub targets make a service change global", async (t) => {
  const db = await fixture(t);
  await db
    .update(serviceDeployments)
    .set({ config: { dbhub: [{ type: "mysql", host: "db.example.test", port: 3306, username: "reader", password: "", database: "orders" }] } })
    .where(eq(serviceDeployments.id, "billing-test"));
  assert.equal((await issuesAffectedByServiceChange(db, "billing")).length, 4);
});

test("capability switches reach environments configuring it plus development, and nothing when unconfigured", async (t) => {
  const db = await fixture(t);
  assert.deepEqual(ids(await issuesAffectedByCapabilityChange(db, "dms")), ["billing-dev-issue", "billing-prod-issue", "orders-prod-issue"]);
  assert.deepEqual(await issuesAffectedByCapabilityChange(db, "sls"), []);
});

test("repository, user and global changes use binding, credential-owner and all-Issue rules", async (t) => {
  const db = await fixture(t);
  assert.deepEqual(ids(await issuesAffectedByRepositoryChange(db, "file:///orders.git")), ["billing-prod-issue", "orders-prod-issue"]);
  assert.deepEqual(await issuesAffectedByRepositoryChange(db, "file:///unbound.git"), []);
  assert.deepEqual(ids(await issuesAffectedByUserChange(db, "assignee")), ["orders-prod-issue"]);
  assert.equal((await issuesAffectedByUserChange(db, issuePilotConfig.bootstrapUser.subject)).length, 4);
  assert.equal((await issuesAffectedByGlobalChange(db)).length, 4);
});
