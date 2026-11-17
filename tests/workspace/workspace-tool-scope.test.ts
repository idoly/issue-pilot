import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { eq } from "drizzle-orm";

import { createWorkspaceTool } from "../../src/agent/workspace-tool.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issueServiceScopes, issueWorkspaces, issues, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services, subjects } from "../../src/db/schema.ts";
import { claimIssueRoot, issueRoot } from "../../src/workspace/state.ts";
import { createBareRemote } from "../helpers/git.ts";
import { registerTestRepositories } from "../helpers/repositories.ts";

test("reverts the persisted service scope when preparation fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-workspace-scope-"));
  const stateRoot = path.join(root, "state");
  const database = await openApplicationDatabase(path.join(stateRoot, "issues.db"));
  try {
    const primary = await createBareRemote(root, { source: "primary-source", remote: "primary.git" });
    const extra = await createBareRemote(root, { source: "extra-source", remote: "extra.git" });
    await registerTestRepositories(database.db, [primary.remote, extra.remote]);
    const [dev] = await database.db.select().from(environments).where(eq(environments.kind, "dev")).limit(1);
    const [prod] = await database.db.select().from(environments).where(eq(environments.kind, "prod")).limit(1);
    assert.ok(dev && prod);
    await database.db.insert(subjects).values({ subject: "scope-tester", role: "developer" });
    const [entryService] = await database.db.insert(services).values({ key: "entry", name: "Entry" }).returning();
    const [extraService] = await database.db.insert(services).values({ key: "extra", name: "Extra" }).returning();
    for (const [service, remote] of [
      [entryService!, primary.remote],
      [extraService!, extra.remote],
    ] as const) {
      const [repository] = await database.db.insert(serviceRepositories).values({ serviceId: service.id, alias: service.key, url: remote }).returning();
      await database.db.insert(serviceDeployments).values({ serviceId: service.id, environmentId: dev.id, config: {} });
      const [production] = await database.db.insert(serviceDeployments).values({ serviceId: service.id, environmentId: prod.id, config: {} }).returning();
      await database.db.insert(serviceDeploymentRepositories).values({ deploymentId: production!.id, repositoryId: repository!.id, baseBranch: "main" });
    }
    const [issue] = await database.db
      .insert(issues)
      .values({ key: "ISSUE-20261117-001", title: "Scope rollback", type: "defect_fix", serviceId: entryService!.id, environmentId: dev.id, reporterSubject: "scope-tester" })
      .returning();
    await claimIssueRoot(stateRoot, issue!.key);
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", runtimeReady: true });
    await database.db.insert(issueServiceScopes).values({ issueId: issue!.id, serviceId: extraService!.id });

    const scopeChanges: Array<string[] | undefined> = [];
    const tool = await createWorkspaceTool(
      database.db,
      issue!,
      "dev",
      {
        prepare: async () => {
          throw new Error("workspace_has_changes");
        },
      } as never,
      {
        stateRoot,
        runtimeRoot: issueRoot(stateRoot, issue!.key),
        commitEnvironment: {},
        networkDomains: [],
        onScopeChanged: (readRoots) => scopeChanges.push(readRoots),
      },
    );
    // The removal target's worktree has uncommitted changes, so preparation fails after the membership write.
    await assert.rejects(tool.execute("remove", { operation: "remove", service: "extra" }, undefined, undefined, undefined as never), /workspace_has_changes/);
    assert.deepEqual(
      (await database.db.select().from(issueServiceScopes).where(eq(issueServiceScopes.issueId, issue!.id))).map((row) => row.serviceId),
      [extraService!.id],
    );
    const [workspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id));
    assert.equal(workspace!.runtimeReady, false);
    // The live session is still retired so the next round re-prepares from the reverted membership.
    assert.deepEqual(scopeChanges, [undefined]);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
