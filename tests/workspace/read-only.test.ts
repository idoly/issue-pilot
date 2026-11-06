import { registerTestRepositories } from "../helpers/repositories.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
import { IssueProjectManager, prepareReadOnlyIssueRuntimes } from "../../src/workspace/project.ts";
import { WorktreeManager } from "../../src/workspace/git.ts";
import { errorChain } from "../../src/diagnostics.ts";
import { claimIssueRoot, issueRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

const execFileAsync = promisify(execFile);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const repositoryFails of [false, true]) {
  test(`read-only recovery waits for repository preparation after related context fails (repository failure: ${repositoryFails})`, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-readonly-settlement-"));
    const database = await openApplicationDatabase(path.join(root, "issues.db"));
    const release = deferred();
    const entered = deferred();
    const relatedChecked = deferred();
    const repositoryFailure = new Error("fixture_repository_failed");
    let pending: Promise<unknown> | undefined;
    try {
      const [prod] = await database.db.select().from(environments).where(eq(environments.kind, "prod"));
      const [service] = await database.db.insert(services).values({ key: "settlement", name: "Settlement" }).returning();
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
            title: "Settle runtime",
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
      // A stored session whose ancestor is now a regular file causes a real ENOTDIR boundary failure.
      await writeFile(relatedRoot, "preserve recovery evidence");
      const sessionFile = path.join(relatedRoot, ".session-current.jsonl");
      await database.db.insert(agentSessions).values({ issueId: related!.id, sessionFile, workspacePath: relatedRoot });
      const access = fs.access;
      context.mock.method(fs, "access", async (...args: Parameters<typeof fs.access>) => {
        try {
          return await access(...args);
        } finally {
          if (args[0] === sessionFile) relatedChecked.resolve();
        }
      });
      syncBuiltinESMExports();
      const checkout = path.join(sharedCheckoutsRoot(root), "repository", "commit");
      await mkdir(checkout, { recursive: true });
      const worktrees = new WorktreeManager(root);
      let failRepository = repositoryFails;
      worktrees.prepareShared = async () => {
        entered.resolve();
        await release.promise;
        if (failRepository) throw repositoryFailure;
        return { cachePath: path.join(root, "cache"), workspacePath: checkout, baseBranch: "main", workingBranch: null, baseCommit: "fixture-commit" };
      };
      const projects = new IssueProjectManager(database.db, root, worktrees);
      let settled = false;
      const outcome = projects.hydrateReadOnlyRuntime(issue!).then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      pending = outcome;
      await entered.promise;
      await relatedChecked.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "recovery must retain ownership until the Git operation finishes");
      release.resolve();
      const failures = errorChain(await outcome);
      assert.ok(failures.some((error) => error && typeof error === "object" && "code" in error && error.code === "ENOTDIR"));
      assert.equal(failures.includes(repositoryFailure), repositoryFails);
      assert.equal((await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).length, 0);

      failRepository = false;
      await rm(relatedRoot);
      await mkdir(relatedRoot);
      await projects.hydrateReadOnlyRuntime(issue!);
      assert.equal((await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id)))[0]!.runtimeReady, true);
    } finally {
      release.resolve();
      await pending;
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

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

async function withGitFetchCount<T>(root: string, operation: () => Promise<T>): Promise<{ result: T; fetches: number }> {
  const binRoot = path.join(root, "bin");
  const fetchLog = path.join(root, "fetch.log");
  const gitExecutable = (await execFileAsync("sh", ["-c", "command -v git"], { encoding: "utf8" })).stdout.trim();
  await mkdir(binRoot);
  await writeFile(fetchLog, "", "utf8");
  await writeFile(
    path.join(binRoot, "git"),
    `#!/bin/sh
for argument do
  if [ "$argument" = fetch ]; then printf 'fetch\\n' >> "$ISSUE_PILOT_FETCH_LOG"; break; fi
done
exec ${JSON.stringify(gitExecutable)} "$@"
`,
    { mode: 0o700 },
  );

  const previousPath = process.env.PATH;
  const previousFetchLog = process.env.ISSUE_PILOT_FETCH_LOG;
  try {
    process.env.PATH = `${binRoot}:${previousPath ?? ""}`;
    process.env.ISSUE_PILOT_FETCH_LOG = fetchLog;
    const result = await operation();
    const fetches = (await readFile(fetchLog, "utf8")).split("\n").filter(Boolean).length;
    return { result, fetches };
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousFetchLog === undefined) delete process.env.ISSUE_PILOT_FETCH_LOG;
    else process.env.ISSUE_PILOT_FETCH_LOG = previousFetchLog;
  }
}

test("hydrates current read-only issue runtimes from deployment branches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-read-only-runtime-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const remote = await createRemote(root);
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
    const [issue, secondIssue] = await database.db
      .insert(issues)
      .values([
        { ...issueValues, key: "ISSUE-20260810-201", title: "Inspect production" },
        { ...issueValues, key: "ISSUE-20260810-202", title: "Inspect the same production deployment" },
      ])
      .returning();
    await claimIssueRoot(root, issue!.key);
    await claimIssueRoot(root, secondIssue!.key);
    await database.db.insert(issueWorkspaces).values([
      { issueId: issue!.id, status: "ready", runtimeReady: false },
      { issueId: secondIssue!.id, status: "ready", runtimeReady: false },
    ]);
    await database.db.insert(agentSessions).values(
      [issue!, secondIssue!].map((entry) => ({
        issueId: entry.id,
        sessionFile: path.join(issueRoot(root, entry.key), "session.jsonl"),
        workspacePath: issueRoot(root, entry.key),
      })),
    );

    const runtimeDatabase = database.db as typeof database.db & { transaction<T>(operation: (transaction: unknown) => Promise<T>): Promise<T> };
    const runTransaction = runtimeDatabase.transaction.bind(runtimeDatabase);
    let activeTransactions = 0;
    let maximumActiveTransactions = 0;
    runtimeDatabase.transaction = (async (operation) => {
      activeTransactions += 1;
      maximumActiveTransactions = Math.max(maximumActiveTransactions, activeTransactions);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await runTransaction(operation);
      } finally {
        activeTransactions -= 1;
      }
    }) as typeof runtimeDatabase.transaction;
    const { result, fetches } = await (async () => {
      try {
        return await withGitFetchCount(root, () => prepareReadOnlyIssueRuntimes(database.db, root));
      } finally {
        runtimeDatabase.transaction = runTransaction;
      }
    })();
    assert.deepEqual([...result.prepared].sort(), [issue!.key, secondIssue!.key]);
    assert.deepEqual(result.blocked, []);
    assert.equal(fetches, 1);
    assert.equal(maximumActiveTransactions, 1);
    await database.db.delete(issues).where(eq(issues.id, secondIssue!.id));

    const [repository] = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    const [workspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id));
    const [session] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue!.id));
    assert.equal(repository!.localPath, null);
    const checkoutRoot = await git(["-C", path.join(issueRoot(root, issue!.key), "remote"), "rev-parse", "--show-toplevel"]);
    assert.equal(path.relative(sharedCheckoutsRoot(root), checkoutRoot).startsWith(".."), false);
    assert.equal(workspace!.runtimeReady, true);
    assert.equal(session!.workspacePath, issueRoot(root, issue!.key));
    const unchangedAt = new Date(2_000);
    await database.db.update(issueRepositories).set({ updatedAt: unchangedAt }).where(eq(issueRepositories.issueId, issue!.id));
    await database.db.update(issueWorkspaces).set({ updatedAt: unchangedAt }).where(eq(issueWorkspaces.issueId, issue!.id));
    await database.db.update(agentSessions).set({ updatedAt: unchangedAt }).where(eq(agentSessions.issueId, issue!.id));
    assert.deepEqual(await prepareReadOnlyIssueRuntimes(database.db, root), { prepared: [issue!.key], blocked: [] });
    for (const table of [issueRepositories, issueWorkspaces, agentSessions]) {
      const [unchanged] = await database.db.select({ updatedAt: table.updatedAt }).from(table);
      assert.equal(unchanged!.updatedAt.getTime(), unchangedAt.getTime());
    }

    const extraRemote = path.join(root, "extra.git");
    await git(["clone", "--bare", remote, extraRemote]);
    await registerTestRepositories(database.db, [extraRemote]);
    const [extraRepository] = await database.db.insert(serviceRepositories).values({ serviceId: service!.id, alias: "extra", url: extraRemote }).returning();
    await database.db.insert(serviceDeploymentRepositories).values({ deploymentId: deployment!.id, repositoryId: extraRepository!.id, baseBranch: "missing" });
    const failedSwitch = await prepareReadOnlyIssueRuntimes(database.db, root);
    assert.equal(failedSwitch.blocked[0]?.issueKey, issue!.key);
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
    const failedTransaction = await prepareReadOnlyIssueRuntimes(database.db, root);
    assert.deepEqual(failedTransaction, { prepared: [], blocked: [{ issueKey: issue!.key, reason: "simulated_readonly_repository_transaction_failure" }] });
    assert.deepEqual(
      (await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).map(({ url }) => url),
      [remote],
    );
    assert.equal((await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id)))[0]!.runtimeReady, false);
    runtimeDatabase.transaction = runTransaction;
    assert.deepEqual(await prepareReadOnlyIssueRuntimes(database.db, root), { prepared: [issue!.key], blocked: [] });
    assert.deepEqual(
      (await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).map(({ url }) => url),
      [remote, extraRemote],
    );

    await database.db.update(issueRepositories).set({ workingBranch: "unexpected-branch" }).where(eq(issueRepositories.issueId, issue!.id));
    const invalid = await prepareReadOnlyIssueRuntimes(database.db, root);
    assert.deepEqual(invalid, { prepared: [], blocked: [{ issueKey: issue!.key, reason: "readonly_repository_state_invalid" }] });
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
      await assert.rejects(projects.hydrateReadOnlyRuntime(issue), { message: "issue_root_missing" });
    }
    await assert.rejects(lstat(issueRoot(root, issue.key)), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(root, "git")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
