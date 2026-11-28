import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createWorkspaceTool } from "../../src/agent/workspace-tool.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { openDatabase } from "../../src/db/client.ts";
import {
  environments,
  issueRepositories,
  issueServiceScopes,
  issues,
  issueWorkspaces,
  serviceDeploymentRepositories,
  serviceDeployments,
  serviceRepositories,
  services,
  subjects,
} from "../../src/db/schema.ts";
import { IssueProjectManager } from "../../src/workspace/project.ts";
import { repositoryStorePath, WorktreeManager } from "../../src/workspace/git.ts";
import { claimIssueRoot, issueRoot } from "../../src/workspace/state.ts";
import { createBareRemote } from "../helpers/git.ts";
import { registerTestRepositories } from "../helpers/repositories.ts";

async function fixture(kind: "test" | "prod") {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-readonly-scope-"));
  const state = path.join(root, "state");
  const file = path.join(state, "issues.db");
  const db = await openApplicationDatabase(file);
  const observer = openDatabase(file);
  const close = async () => {
    await observer.close();
    await db.close();
    await rm(root, { recursive: true, force: true });
  };
  try {
    const [env] = await db.db.select().from(environments).where(eq(environments.kind, kind));
    const addService = async (key: string) => {
      const { remote } = await createBareRemote(root, { remote: `${key}.git`, source: `${key}-seed` });
      await registerTestRepositories(db.db, [remote]);
      const [service] = await db.db.insert(services).values({ key, name: key }).returning();
      const [repository] = await db.db.insert(serviceRepositories).values({ serviceId: service!.id, alias: key, url: remote }).returning();
      const [deployment] = await db.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: env!.id, config: {} }).returning();
      await db.db.insert(serviceDeploymentRepositories).values({ deploymentId: deployment!.id, repositoryId: repository!.id, baseBranch: "main" });
      return { url: remote, serviceId: service!.id, deploymentId: deployment!.id };
    };
    const primary = await addService("entry");
    const extra = await addService("extra");
    await db.db.insert(subjects).values({ subject: "reviewer", role: "test" });
    const [issue] = await db.db
      .insert(issues)
      .values({ key: "ISSUE-20261128-001", title: "Scope fixture", type: "smart_analysis", serviceId: primary.serviceId, environmentId: env!.id, reporterSubject: "reviewer" })
      .returning();
    await claimIssueRoot(state, issue!.key);
    const dir = issueRoot(state, issue!.key);
    await db.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", runtimeReady: true });
    const git = new WorktreeManager(state);
    const project = new IssueProjectManager(db.db, state, git);
    await project.prepare(issue!, kind);
    const notifications: (string[] | undefined)[] = [];
    const tool = await createWorkspaceTool(db.db, issue!, kind, project, {
      stateRoot: state,
      runtimeRoot: dir,
      commitEnvironment: {},
      networkDomains: [],
      onScopeChanged: (r) => notifications.push(r),
    });
    const change = (operation: "include" | "remove", signal?: AbortSignal) => tool.execute(operation, { operation, service: "extra" }, signal, undefined, {} as never);
    const snapshot = async () => ({
      members: (await observer.db.select().from(issueServiceScopes)).map((row) => row.serviceId),
      urls: (await observer.db.select().from(issueRepositories)).map((row) => row.url).sort(),
      ready: (await observer.db.select().from(issueWorkspaces))[0]!.runtimeReady,
    });
    return { db, observer, primary, extra, issueId: issue!.id, dir, state, git, change, snapshot, notifications, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test("a rejected read-only include never commits the candidate repositories", async () => {
  const f = await fixture("test");
  try {
    const collision = path.join(f.dir, "extra");
    await writeFile(collision, "keep ordinary evidence", { flag: "wx" });
    await assert.rejects(f.change("include"), /issue_runtime_path_collision/);
    assert.deepEqual(await f.snapshot(), { members: [], urls: [f.primary.url], ready: false });
    assert.deepEqual([...f.notifications], [undefined]);
    assert.equal(await readFile(collision, "utf8"), "keep ordinary evidence");
    await rm(collision);
    await f.change("include");
    await f.change("include");
    assert.deepEqual(await f.snapshot(), { members: [f.extra.serviceId], urls: [f.primary.url, f.extra.url].sort(), ready: true });
    assert.equal(f.notifications.length, 2);
    const extraStore = repositoryStorePath(f.state, f.extra.url);
    assert.ok(f.notifications[1]?.includes(extraStore));
    await f.change("remove");
    await f.change("remove");
    assert.deepEqual(await f.snapshot(), { members: [], urls: [f.primary.url], ready: true });
    assert.equal(f.notifications.length, 3);
    assert.ok(f.notifications[2]?.includes(repositoryStorePath(f.state, f.primary.url)));
    assert.equal(f.notifications[2]?.includes(extraStore), false);
  } finally {
    await f.close();
  }
});

test("a concurrent membership change is not adopted or reverted by a stale read-only plan", async (t) => {
  const f = await fixture("prod");
  try {
    const prepare = f.git.prepareShared.bind(f.git);
    t.mock.method(
      f.git,
      "prepareShared",
      async (...args: Parameters<typeof prepare>) => {
        const checkout = await prepare(...args);
        await f.observer.db.insert(issueServiceScopes).values({ issueId: f.issueId, serviceId: f.extra.serviceId });
        return checkout;
      },
      { times: 1 },
    );
    await assert.rejects(f.change("include"), /issue_scope_changed/);
    assert.deepEqual(await f.snapshot(), { members: [f.extra.serviceId], urls: [f.primary.url], ready: false });
    assert.deepEqual([...f.notifications], [undefined]);
    await f.change("include");
    assert.deepEqual(await f.snapshot(), { members: [f.extra.serviceId], urls: [f.primary.url, f.extra.url].sort(), ready: true });
  } finally {
    await f.close();
  }
});

for (const failure of ["cancel", "changed deployment", "commit"] as const)
  test(`read-only scope stays unpublished during preparation and after ${failure}`, async (t) => {
    const f = await fixture("prod");
    try {
      // For a removal, final commit failure must preserve the *old* membership AND its repository row.
      const removing = failure === "commit";
      if (removing) await f.change("include");
      const before = await f.snapshot();
      const ctrl = new AbortController();
      const prepare = f.git.prepareShared.bind(f.git);
      let observed = false;
      const hook = t.mock.method(f.git, "prepareShared", async (...args: Parameters<typeof prepare>) => {
        const checkout = await prepare(...args);
        if (!observed) {
          observed = true;
          assert.deepEqual(await f.snapshot(), { ...before, ready: false });
          if (failure === "cancel") ctrl.abort(new Error("fixture_abort"));
          if (failure === "changed deployment")
            await f.observer.db.update(serviceDeploymentRepositories).set({ baseBranch: "changed" }).where(eq(serviceDeploymentRepositories.deploymentId, f.extra.deploymentId));
        }
        return checkout;
      });
      if (removing)
        await f.db.client.execute("CREATE TRIGGER fail_ready BEFORE UPDATE OF runtime_ready ON issue_workspaces WHEN NEW.runtime_ready=1 BEGIN SELECT RAISE(ABORT,'fixture_commit_failure'); END");
      await assert.rejects(
        f.change(removing ? "remove" : "include", ctrl.signal),
        failure === "cancel" ? /fixture_abort/ : removing ? /Failed query|fixture_commit_failure/i : /scope_transition_plan_stale|issue_scope_changed/,
      );
      assert.equal(observed, true);
      assert.deepEqual(await f.snapshot(), { ...before, ready: false });
      assert.equal(f.notifications.length, removing ? 2 : 1);
      assert.equal(f.notifications.at(-1), undefined);
      hook.mock.restore();
      if (removing) await f.db.client.execute("DROP TRIGGER fail_ready");
      if (failure === "changed deployment")
        await f.observer.db.update(serviceDeploymentRepositories).set({ baseBranch: "main" }).where(eq(serviceDeploymentRepositories.deploymentId, f.extra.deploymentId));
      await f.change(removing ? "remove" : "include");
      assert.deepEqual(await f.snapshot(), { members: removing ? [] : [f.extra.serviceId], urls: removing ? [f.primary.url] : [f.primary.url, f.extra.url].sort(), ready: true });
    } finally {
      await f.close();
    }
  });
