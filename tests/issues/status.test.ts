import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { eq } from "drizzle-orm";

import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issues, serviceDeployments, services, subjects } from "../../src/db/schema.ts";
import { transitionIssue } from "../../src/issues/status.ts";

test("Issue status transitions apply only from the stated statuses and touch resolvedAt only when asked", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-status-"));
  const database = await openApplicationDatabase(join(root, "issues.db"));
  try {
    const [environment] = await database.db.select().from(environments).where(eq(environments.key, "dev"));
    const [service] = await database.db.insert(services).values({ key: "status", name: "Status" }).returning();
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
    await database.db.insert(subjects).values({ subject: "reporter", displayName: "Reporter", role: "developer" });
    const [issue] = await database.db
      .insert(issues)
      .values({ key: "ISSUE-20261118-901", title: "Status fixture", type: "defect_fix", serviceId: service!.id, environmentId: environment!.id, reporterSubject: "reporter", status: "pending" })
      .returning();
    const read = async () => (await database.db.select().from(issues).where(eq(issues.id, issue!.id)).limit(1))[0]!;

    const resolved = await transitionIssue(database.db, issue!.id, { from: ["pending"], to: "resolved", resolvedAt: new Date() });
    assert.equal(resolved?.status, "resolved");
    assert.ok((await read()).resolvedAt);

    // Outside the guarded statuses the write is a no-op and the caller keeps its own error.
    assert.equal(await transitionIssue(database.db, issue!.id, { from: ["pending"], to: "resolved", resolvedAt: new Date() }), undefined);
    assert.equal((await read()).status, "resolved");

    // Reopening clears resolvedAt; starting work leaves it untouched when the caller does not mention it.
    const reopened = await transitionIssue(database.db, issue!.id, { from: ["resolved"], to: "open", resolvedAt: null });
    assert.equal(reopened?.status, "open");
    assert.equal((await read()).resolvedAt, null);
    await transitionIssue(database.db, issue!.id, { from: ["open"], to: "in_progress", resolvedAt: null });
    const running = await transitionIssue(database.db, issue!.id, { from: ["in_progress"], to: "pending" });
    assert.equal(running?.status, "pending");
    assert.equal((await read()).resolvedAt, null);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
