import { registerTestRepositories } from "../helpers/repositories.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import {
  agentSessions,
  environments,
  issueRepositories,
  issueRelations,
  issues,
  issueWorkspaces,
  serviceDeploymentRepositories,
  serviceDeployments,
  serviceRepositories,
  services,
  subjects,
} from "../../src/db/schema.ts";
import { IssueProjectManager } from "../../src/workspace/project.ts";
import { WorktreeManager } from "../../src/workspace/git.ts";
import { claimIssueRoot, issueRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

const execFileAsync = promisify(execFile);

test("read-only preparation validates related context before preparing repositories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-readonly-context-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const [prod] = await database.db.select().from(environments).where(eq(environments.kind, "prod"));
    const [service] = await database.db.insert(services).values({ key: "recovery", name: "Recovery" }).returning();
    await database.db.insert(subjects).values({ subject: "tester" });
    const remote = path.join(root, "remote.git");
    await registerTestRepositories(database.db, [remote]);
    const [repository] = await database.db.insert(serviceRepositories).values({ serviceId: service!.id, alias: "remote", url: remote }).returning();
    const [deployment] = await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: prod!.id, config: {} }).returning();
    await database.db.insert(serviceDeploymentRepositories).values({ deploymentId: deployment!.id, repositoryId: repository!.id, baseBranch: "main" });
    const [issue, related] = await database.db
      .insert(issues)
      .values(
        ["001", "002"].map((suffix) => ({
          key: `ISSUE-20261105-${suffix}`,
          title: "Recover runtime",
          type: "smart_analysis" as const,
          serviceId: service!.id,
          environmentId: prod!.id,
          reporterSubject: "tester",
        })),
      )
      .returning();
    await claimIssueRoot(root, issue!.key);
    await database.db.insert(issueWorkspaces).values([issue!, related!].map(({ id }) => ({ issueId: id })));
    await database.db.insert(issueRelations).values({ issueId: issue!.id, relatedIssueId: related!.id });
    const relatedRoot = issueRoot(root, related!.key);
    await mkdir(path.dirname(relatedRoot), { recursive: true });
    // A related Issue root replaced by a regular file must fail before repository preparation.
    await writeFile(relatedRoot, "preserve recovery evidence");
    const sessionFile = path.join(relatedRoot, ".session-current.jsonl");
    await database.db.insert(agentSessions).values({ issueId: related!.id, sessionFile, workspacePath: relatedRoot });
    const checkout = path.join(sharedCheckoutsRoot(root), "repository", "commit");
    await mkdir(checkout, { recursive: true });
    const worktrees = new WorktreeManager(root);
    let preparations = 0;
    worktrees.prepareShared = async () => {
      preparations++;
      return { cachePath: path.join(root, "cache"), workspacePath: checkout, baseBranch: "main", workingBranch: null, baseCommit: "fixture-commit" };
    };
    const projects = new IssueProjectManager(database.db, root, worktrees);
    await assert.rejects(projects.prepare(issue!, "prod"), { message: "related_issue_context_unavailable" });
    assert.equal(preparations, 0);
    assert.equal(await readFile(relatedRoot, "utf8"), "preserve recovery evidence");
    assert.equal((await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).length, 0);

    await rm(relatedRoot);
    await mkdir(relatedRoot);
    const prepared = await projects.prepare(issue!, "prod");
    assert.equal(preparations, 1);
    assert.equal(prepared.runtimeReady, true);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function git(args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { encoding: "utf8" })).stdout.trim();
}

async function createRemote(root: string): Promise<string> {
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  await git(["init", "-b", "main", source]);
  await writeFile(path.join(source, "README.md"), "baseline\n", "utf8");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"]);
  await git(["clone", "--bare", source, remote]);
  return remote;
}

test("prepares current read-only issue runtimes from deployment branches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-read-only-runtime-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const remote = await createRemote(root);
    const source = path.join(root, "source");
    const [prod] = await database.db.select().from(environments).where(eq(environments.kind, "prod")).limit(1);
    await database.db.insert(subjects).values({ subject: "tester" });
    const [service] = await database.db.insert(services).values({ key: "orders", name: "Orders" }).returning();
    await registerTestRepositories(database.db, [remote]);
    const [serviceRepository] = await database.db.insert(serviceRepositories).values({ serviceId: service!.id, alias: "orders", url: remote }).returning();
    const [deployment] = await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: prod!.id, config: {} }).returning();
    await database.db.insert(serviceDeploymentRepositories).values({ deploymentId: deployment!.id, repositoryId: serviceRepository!.id, baseBranch: "main" });
    const issueValues = {
      type: "smart_analysis" as const,
      serviceId: service!.id,
      environmentId: prod!.id,
      reporterSubject: "tester",
    };
    const [issue] = await database.db
      .insert(issues)
      .values({ ...issueValues, key: "ISSUE-20260810-201", title: "Inspect production" })
      .returning();
    await claimIssueRoot(root, issue!.key);
    const rootDirectory = issueRoot(root, issue!.key);
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", runtimeReady: false });
    await database.db.insert(agentSessions).values({
      issueId: issue!.id,
      sessionFile: path.join(rootDirectory, "session.jsonl"),
      workspacePath: rootDirectory,
    });

    const projects = new IssueProjectManager(database.db, root);
    const prepare = async () => {
      const prepared = await projects.prepare(issue!, "prod");
      assert.equal(prepared.runtimeReady, true);
      return prepared.runtimeRoot;
    };
    assert.equal(await prepare(), rootDirectory);
    const runtimeDatabase = database.db as typeof database.db & { transaction<T>(operation: (transaction: unknown) => Promise<T>): Promise<T> };
    const runTransaction = runtimeDatabase.transaction.bind(runtimeDatabase);
    const [repository] = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    const [workspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id));
    const [session] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue!.id));
    assert.equal(repository!.localPath, null);
    const checkoutRoot = await git(["-C", path.join(issueRoot(root, issue!.key), "remote"), "rev-parse", "--show-toplevel"]);
    assert.equal(path.relative(sharedCheckoutsRoot(root), checkoutRoot).startsWith(".."), false);
    assert.equal(workspace!.runtimeReady, false);
    assert.equal(session!.workspacePath, issueRoot(root, issue!.key));
    const unchangedAt = new Date(2_000);
    await database.db.update(issueRepositories).set({ updatedAt: unchangedAt }).where(eq(issueRepositories.issueId, issue!.id));
    await database.db.update(issueWorkspaces).set({ updatedAt: unchangedAt }).where(eq(issueWorkspaces.issueId, issue!.id));
    await database.db.update(agentSessions).set({ updatedAt: unchangedAt }).where(eq(agentSessions.issueId, issue!.id));
    assert.equal(await prepare(), rootDirectory);
    for (const table of [issueRepositories, issueWorkspaces, agentSessions]) {
      const [unchanged] = await database.db.select({ updatedAt: table.updatedAt }).from(table);
      assert.equal(unchanged!.updatedAt.getTime(), unchangedAt.getTime());
    }

    await writeFile(path.join(source, "README.md"), "updated branch\n");
    await git(["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-am", "advance main"]);
    await git(["-C", source, "push", remote, "main"]);
    assert.equal(await prepare(), rootDirectory);
    assert.equal(await readFile(path.join(issueRoot(root, issue!.key), "remote", "README.md"), "utf8"), "updated branch\n");
    assert.equal(await readFile(path.join(checkoutRoot, "README.md"), "utf8"), "baseline\n");

    const extraRemote = path.join(root, "extra.git");
    await git(["clone", "--bare", remote, extraRemote]);
    await registerTestRepositories(database.db, [extraRemote]);
    const [extraRepository] = await database.db.insert(serviceRepositories).values({ serviceId: service!.id, alias: "extra", url: extraRemote }).returning();
    await database.db.insert(serviceDeploymentRepositories).values({ deploymentId: deployment!.id, repositoryId: extraRepository!.id, baseBranch: "missing" });
    await assert.rejects(prepare(), /couldn't find remote ref missing/);
    assert.deepEqual(
      (await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).map(({ url }) => url),
      [remote],
    );
    await database.db.update(serviceDeploymentRepositories).set({ baseBranch: "main" }).where(eq(serviceDeploymentRepositories.repositoryId, extraRepository!.id));
    let failRepositoryTransaction = true;
    runtimeDatabase.transaction = (async (operation) => {
      if (failRepositoryTransaction) {
        failRepositoryTransaction = false;
        throw new Error("simulated_readonly_repository_transaction_failure");
      }
      return runTransaction(operation);
    }) as typeof runtimeDatabase.transaction;
    await assert.rejects(prepare(), /simulated_readonly_repository_transaction_failure/);
    assert.deepEqual(
      (await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).map(({ url }) => url),
      [remote],
    );
    assert.equal((await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id)))[0]!.runtimeReady, false);
    runtimeDatabase.transaction = runTransaction;
    assert.equal(await prepare(), rootDirectory);
    assert.deepEqual(
      (await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).map(({ url }) => url),
      [remote, extraRemote],
    );

    await database.db.update(issueRepositories).set({ workingBranch: "unexpected-branch" }).where(eq(issueRepositories.issueId, issue!.id));
    await assert.rejects(prepare(), /readonly_repository_state_invalid/);
    const [preserved] = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal(preserved!.workingBranch, "unexpected-branch");
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing durable Issue roots stop project preparation before database or Git operations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-project-root-"));
  const unexpected = () => {
    throw new Error("must_not_touch_database_or_git");
  };
  const database = { select: unexpected, transaction: unexpected };
  const worktrees = new WorktreeManager(root);
  worktrees.prepare = unexpected;
  worktrees.prepareShared = unexpected;
  const projects = new IssueProjectManager(database as never, root, worktrees);
  const issue = { id: "fixture", key: "ISSUE-20261107-802", type: "smart_analysis" as const, serviceId: "fixture", environmentId: "fixture" };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const environment of ["prod", "test", "dev"] as const) await assert.rejects(projects.prepare(issue, environment), { message: "issue_root_missing" });
    }
    await assert.rejects(lstat(issueRoot(root, issue.key)), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(root, "git")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
