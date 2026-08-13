import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { agentSessions, environments, issueRepositories, issues, issueWorkspaces, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services, subjects } from "../../src/db/schema.ts";
import { prepareReadOnlyIssueRuntimes } from "../../src/workspace/read-only.ts";
import { issueRuntimeRoot, issueSessionRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

const execFileAsync = promisify(execFile);

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

test("hydrates current read-only issue runtimes from deployment branches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-read-only-runtime-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const remote = await createRemote(root);
    const [prod] = await database.db.select().from(environments).where(eq(environments.kind, "prod")).limit(1);
    await database.db.insert(subjects).values({ subject: "tester" });
    const [service] = await database.db.insert(services).values({ key: "orders", name: "Orders" }).returning();
    const [serviceRepository] = await database.db.insert(serviceRepositories).values({ serviceId: service!.id, alias: "orders", url: remote }).returning();
    const [deployment] = await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: prod!.id, config: {} }).returning();
    await database.db.insert(serviceDeploymentRepositories).values({ deploymentId: deployment!.id, repositoryId: serviceRepository!.id, baseBranch: "main" });
    const [issue] = await database.db.insert(issues).values({
      key: "ISSUE-20260810-201",
      title: "Inspect production",
      type: "smart_analysis",
      serviceId: service!.id,
      environmentId: prod!.id,
      reporterSubject: "tester",
    }).returning();
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", codeServerReady: false });
    await database.db.insert(agentSessions).values({
      issueId: issue!.id,
      sessionFile: path.join(issueSessionRoot(root, issue!.key), "session.jsonl"),
      workspacePath: issueRuntimeRoot(root, issue!.key),
    });

    let codeServerPath = "";
    const result = await prepareReadOnlyIssueRuntimes(database.db, root, {
      async ensure(_issueKey, workspacePath) { codeServerPath = workspacePath; return "http://127.0.0.1:18080"; },
    });
    assert.deepEqual(result, { prepared: [issue!.key], blocked: [] });
    assert.equal(codeServerPath, issueRuntimeRoot(root, issue!.key));

    const [repository] = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    const [workspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id));
    const [session] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue!.id));
    assert.equal(repository!.localPath, null);
    const checkoutRoot = await git(["-C", path.join(codeServerPath, "remote"), "rev-parse", "--show-toplevel"]);
    assert.equal(path.relative(sharedCheckoutsRoot(root), checkoutRoot).startsWith(".."), false);
    assert.equal(workspace!.codeServerReady, true);
    assert.equal(session!.workspacePath, issueRuntimeRoot(root, issue!.key));

    const extraRemote = path.join(root, "extra.git");
    await git(["clone", "--bare", remote, extraRemote]);
    const [extraRepository] = await database.db.insert(serviceRepositories).values({ serviceId: service!.id, alias: "extra", url: extraRemote }).returning();
    await database.db.insert(serviceDeploymentRepositories).values({ deploymentId: deployment!.id, repositoryId: extraRepository!.id, baseBranch: "missing" });
    const failedSwitch = await prepareReadOnlyIssueRuntimes(database.db, root, { async ensure() { throw new Error("code_server_must_not_run"); } });
    assert.equal(failedSwitch.blocked[0]?.issueKey, issue!.key);
    assert.deepEqual((await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).map(({ url }) => url), [remote]);
    await database.db.update(serviceDeploymentRepositories).set({ baseBranch: "main" }).where(eq(serviceDeploymentRepositories.repositoryId, extraRepository!.id));
    const failedEditor = await prepareReadOnlyIssueRuntimes(database.db, root, { async ensure() { throw new Error("code_server_unavailable"); } });
    assert.deepEqual(failedEditor, { prepared: [], blocked: [{ issueKey: issue!.key, reason: "code_server_unavailable" }] });
    assert.deepEqual((await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).map(({ url }) => url), [remote]);
    const runtimeDatabase = database.db as typeof database.db & { transaction<T>(operation: (transaction: unknown) => Promise<T>): Promise<T> };
    const runTransaction = runtimeDatabase.transaction.bind(runtimeDatabase);
    let failRepositoryTransaction = true;
    runtimeDatabase.transaction = (async (operation) => {
      if (failRepositoryTransaction) {
        failRepositoryTransaction = false;
        throw new Error("simulated_readonly_repository_transaction_failure");
      }
      return runTransaction(operation);
    }) as typeof runtimeDatabase.transaction;
    const failedTransaction = await prepareReadOnlyIssueRuntimes(database.db, root, { async ensure() { return "http://127.0.0.1:18080"; } });
    assert.deepEqual(failedTransaction, { prepared: [], blocked: [{ issueKey: issue!.key, reason: "simulated_readonly_repository_transaction_failure" }] });
    assert.deepEqual((await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).map(({ url }) => url), [remote]);
    assert.equal((await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id)))[0]!.codeServerReady, false);
    runtimeDatabase.transaction = runTransaction;
    assert.deepEqual(await prepareReadOnlyIssueRuntimes(database.db, root, { async ensure() { return "http://127.0.0.1:18080"; } }), { prepared: [issue!.key], blocked: [] });
    assert.deepEqual((await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).map(({ url }) => url), [remote, extraRemote]);

    await database.db.update(issueRepositories).set({ workingBranch: "unexpected-branch" }).where(eq(issueRepositories.issueId, issue!.id));
    const invalid = await prepareReadOnlyIssueRuntimes(database.db, root, {
      async ensure() { throw new Error("code_server_must_not_run"); },
    });
    assert.deepEqual(invalid, { prepared: [], blocked: [{ issueKey: issue!.key, reason: "readonly_repository_state_invalid" }] });
    const [preserved] = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal(preserved!.workingBranch, "unexpected-branch");
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
