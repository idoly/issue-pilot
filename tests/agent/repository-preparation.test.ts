import { registerTestRepositories } from "../helpers/repositories.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { and, eq } from "drizzle-orm";

import { AgentEngine } from "../../src/agent/engine.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { agentSessions, environments, globalAgentConfiguration, issueRepositories, issues, issueWorkspaces, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services, subjects, userCredentials } from "../../src/db/schema.ts";
import type { AgentSessionContext } from "../../src/agent/context.ts";
import { repositoryWorkspaceNames } from "../../src/workspace/git.ts";
import { issueRuntimeRoot, issueWorkspaceRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { encoding: "utf8" })).stdout.trim();
}

async function createRemote(root: string): Promise<{ source: string; remotes: [string, string] }> {
  const source = path.join(root, "source");
  const remotes = [path.join(root, "remote.git"), path.join(root, "secondary.git")] as [string, string];
  await git(["init", "-b", "prod", source]);
  await writeFile(path.join(source, "README.md"), "production baseline\n", "utf8");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"]);
  await git(["-C", source, "branch", "develop"]);
  await git(["clone", "--bare", source, remotes[0]]);
  await git(["clone", "--bare", source, remotes[1]]);
  await git(["-C", source, "remote", "add", "origin", remotes[0]]);
  return { source, remotes };
}

test("atomically switches development repository sets across preparation and finalization failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-engine-removal-"));
  const stateRoot = path.join(root, "state");
  const database = await openApplicationDatabase(path.join(stateRoot, "issues.db"));
  try {
    await database.db.insert(globalAgentConfiguration).values({ id: 1, provider: "test-provider", model: "test-model", thinkingLevel: "medium" });
    const { source, remotes: initialRemotes } = await createRemote(root);
    const thirdRemote = path.join(root, "tertiary.git");
    await git(["clone", "--bare", source, thirdRemote]);
    const remotes = [...initialRemotes, thirdRemote];
    const targetRemotes: [string, string] = [path.join(root, "target-a", "shared.git"), path.join(root, "target-b", "shared.git")];
    await Promise.all(targetRemotes.map(async (remote) => {
      await mkdir(path.dirname(remote), { recursive: true });
      await git(["clone", "--bare", source, remote]);
    }));
    const [dev] = await database.db.select().from(environments).where(eq(environments.kind, "dev")).limit(1);
    await database.db.insert(subjects).values({ subject: "tester", displayName: "Tester", role: "developer" });
    await database.db.insert(userCredentials).values({ subject: "tester", modelApiKeys: { "test-provider": "fixture-key" } });
    const [service] = await database.db.insert(services).values({ key: "removal", name: "Removal" }).returning();
    await registerTestRepositories(database.db, remotes);
    const repositories = await database.db.insert(serviceRepositories).values(remotes.map((url, index) => ({ serviceId: service!.id, alias: `repository-${index}`, url }))).returning();
    const [deployment] = await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: dev!.id, config: {} }).returning();
    await database.db.insert(serviceDeploymentRepositories).values(repositories.map((repository) => ({ deploymentId: deployment!.id, repositoryId: repository.id, baseBranch: "develop" })));
    const [issue] = await database.db.insert(issues).values({ key: "ISSUE-20260810-103", title: "Remove repositories", type: "defect_fix", serviceId: service!.id, environmentId: dev!.id, reporterSubject: "tester" }).returning();
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id });

    const engine = new AgentEngine(database.db, stateRoot);
    const internal = engine as unknown as {
      piRuntime: { start(): Promise<unknown>; close(): Promise<void> };
      run(issueId: string): Promise<void>;
    };
    internal.piRuntime = {
      async start() { return { session: {}, streaming: false, async prompt() {}, async stop() {} }; },
      async close() {},
    };
    const [unmanagedIssue] = await database.db.insert(issues).values({ key: "ISSUE-20260810-104", title: "Preserve unmanaged workspace", type: "defect_fix", serviceId: service!.id, environmentId: dev!.id, reporterSubject: "tester" }).returning();
    await database.db.insert(issueWorkspaces).values({ issueId: unmanagedIssue!.id });
    const unmanagedEvidence = path.join(issueWorkspaceRoot(stateRoot, unmanagedIssue!.key), "operator-evidence.txt");
    await mkdir(path.dirname(unmanagedEvidence), { recursive: true });
    await writeFile(unmanagedEvidence, "preserve\n", "utf8");
    await assert.rejects(internal.run(unmanagedIssue!.id), /workspace_has_untracked_files/);
    assert.equal((await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, unmanagedIssue!.id))).length, 0);
    assert.equal(await readFile(unmanagedEvidence, "utf8"), "preserve\n");

    await internal.run(issue!.id);
    const prepared = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    const preparedByUrl = new Map(prepared.map((repository) => [repository.url, repository]));
    const firstRemovedPath = preparedByUrl.get(remotes[1]!)!.localPath!;
    const dirtyRemovedPath = preparedByUrl.get(remotes[2]!)!.localPath!;
    await writeFile(path.join(dirtyRemovedPath, "untracked.txt"), "preserve\n", "utf8");
    await database.db.delete(serviceRepositories).where(eq(serviceRepositories.id, repositories[1]!.id));
    await database.db.delete(serviceRepositories).where(eq(serviceRepositories.id, repositories[2]!.id));
    await registerTestRepositories(database.db, targetRemotes);
    const targetRepositories = await database.db.insert(serviceRepositories).values(targetRemotes.map((url, index) => ({ serviceId: service!.id, alias: `target-${index}`, url }))).returning();
    await database.db.insert(serviceDeploymentRepositories).values(targetRepositories.map((repository) => ({ deploymentId: deployment!.id, repositoryId: repository.id, baseBranch: "develop" })));
    const targetNames = repositoryWorkspaceNames(targetRemotes);
    const targetPaths = targetRemotes.map((remote) => path.join(issueWorkspaceRoot(stateRoot, issue!.key), targetNames.get(remote)!));

    await assert.rejects(internal.run(issue!.id), /workspace_has_changes/);
    await Promise.all([access(firstRemovedPath), access(dirtyRemovedPath), ...targetPaths.map((targetPath) => assert.rejects(access(targetPath)))]);
    const retained = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.deepEqual(retained.map((repository) => repository.url).sort(), [...remotes].sort());

    await rm(path.join(dirtyRemovedPath, "untracked.txt"));
    await database.db.update(serviceDeploymentRepositories).set({ baseBranch: "missing" }).where(and(
      eq(serviceDeploymentRepositories.deploymentId, deployment!.id),
      eq(serviceDeploymentRepositories.repositoryId, targetRepositories[1]!.id),
    ));
    await assert.rejects(internal.run(issue!.id));
    await Promise.all([...prepared.map((repository) => access(repository.localPath!)), ...targetPaths.map((targetPath) => assert.rejects(access(targetPath)))]);
    assert.deepEqual((await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).map((repository) => repository.url).sort(), [...remotes].sort());
    await database.db.update(serviceDeploymentRepositories).set({ baseBranch: "develop" }).where(and(
      eq(serviceDeploymentRepositories.deploymentId, deployment!.id),
      eq(serviceDeploymentRepositories.repositoryId, targetRepositories[1]!.id),
    ));
    const engineDatabase = (engine as unknown as { database: { transaction<T>(operation: (transaction: unknown) => Promise<T>): Promise<T> } }).database;
    const runTransaction = engineDatabase.transaction.bind(engineDatabase);
    let failRepositoryTransaction = true;
    engineDatabase.transaction = (async (operation) => {
      if (failRepositoryTransaction) {
        failRepositoryTransaction = false;
        throw new Error("simulated_repository_transaction_failure");
      }
      return runTransaction(operation);
    }) as typeof engineDatabase.transaction;
    await assert.rejects(internal.run(issue!.id), /simulated_repository_transaction_failure/);
    await Promise.all([...prepared.map((repository) => access(repository.localPath!)), ...targetPaths.map((targetPath) => assert.rejects(access(targetPath)))]);
    assert.deepEqual((await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).map((repository) => repository.url).sort(), [...remotes].sort());

    engineDatabase.transaction = runTransaction;
    await internal.run(issue!.id);
    await Promise.all([assert.rejects(access(firstRemovedPath)), assert.rejects(access(dirtyRemovedPath)), ...targetPaths.map((targetPath) => access(targetPath))]);
    const switched = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.deepEqual(switched.map((repository) => repository.url), [remotes[0], ...targetRemotes]);
    const retainedTarget = switched.find((repository) => repository.url === targetRemotes[0])!;
    const retainedTargetName = retainedTarget.workspaceName!;
    assert.equal(retainedTargetName, targetNames.get(targetRemotes[0]));
    assert.equal(retainedTarget.localPath, targetPaths[0]);

    await database.db.delete(serviceRepositories).where(eq(serviceRepositories.id, targetRepositories[1]!.id));
    await internal.run(issue!.id);
    await assert.rejects(access(targetPaths[1]!));
    assert.equal((await readdir(issueWorkspaceRoot(stateRoot, issue!.key))).includes(retainedTargetName), true);
    const reduced = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.deepEqual(reduced.map((repository) => repository.url), [remotes[0], targetRemotes[0]]);
    assert.equal(reduced.find((repository) => repository.url === targetRemotes[0])!.localPath, retainedTarget.localPath);
    assert.equal(reduced.find((repository) => repository.url === targetRemotes[0])!.workspaceName, retainedTarget.workspaceName);
    await engine.close();
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("uses unified issue runtimes while preserving read-only and writable Agent workspaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-engine-repositories-"));
  const stateRoot = path.join(root, "state");
  const database = await openApplicationDatabase(path.join(stateRoot, "issues.db"));
  const starts: Array<{ context: AgentSessionContext; workspaceRoot: string }> = [];
  let sessionStops = 0;
  try {
    await database.db.insert(globalAgentConfiguration).values({ id: 1, provider: "test-provider", model: "test-model", thinkingLevel: "medium" });
    const { source, remotes } = await createRemote(root);
    const environmentRows = await database.db.select().from(environments);
    const prod = environmentRows.find((environment) => environment.kind === "prod")!;
    const dev = environmentRows.find((environment) => environment.kind === "dev")!;
    await database.db.insert(subjects).values({ subject: "tester", displayName: "Tester", role: "developer" });
    await database.db.insert(userCredentials).values({ subject: "tester", modelApiKeys: { "test-provider": "fixture-key" } });
    const [service] = await database.db.insert(services).values({ key: "orders", name: "Orders" }).returning();
    await registerTestRepositories(database.db, remotes);
    const repositories = await database.db.insert(serviceRepositories).values([
      { serviceId: service!.id, alias: "orders", url: remotes[0] },
      { serviceId: service!.id, alias: "orders-secondary", url: remotes[1] },
    ]).returning();
    const deployments = await database.db.insert(serviceDeployments).values([
      { serviceId: service!.id, environmentId: prod.id, config: {} },
      { serviceId: service!.id, environmentId: dev.id, config: {} },
    ]).returning();
    await database.db.insert(serviceDeploymentRepositories).values([
      { deploymentId: deployments[0]!.id, repositoryId: repositories[0]!.id, baseBranch: "prod" },
      { deploymentId: deployments[0]!.id, repositoryId: repositories[1]!.id, baseBranch: "develop" },
      { deploymentId: deployments[1]!.id, repositoryId: repositories[0]!.id, baseBranch: "develop" },
      { deploymentId: deployments[1]!.id, repositoryId: repositories[1]!.id, baseBranch: "prod" },
    ]);
    const [prodIssue, devIssue] = await database.db.insert(issues).values([
      { key: "ISSUE-20260810-101", title: "Inspect prod", type: "smart_analysis", serviceId: service!.id, environmentId: prod.id, reporterSubject: "tester" },
      { key: "ISSUE-20260810-102", title: "Fix dev", type: "defect_fix", serviceId: service!.id, environmentId: dev.id, reporterSubject: "tester" },
    ]).returning();
    await database.db.insert(issueWorkspaces).values([{ issueId: prodIssue!.id }, { issueId: devIssue!.id }]);

    const engine = new AgentEngine(database.db, stateRoot);
    const internal = engine as unknown as {
      piRuntime: { start(options: { context: AgentSessionContext; workspaceRoot: string }): Promise<unknown>; close(): Promise<void> };
      run(issueId: string): Promise<void>;
    };
    internal.piRuntime = {
      async start(options) {
        starts.push(options);
        return { session: {}, streaming: false, async prompt() {}, async stop() { sessionStops += 1; } };
      },
      async close() {},
    };
    await internal.run(prodIssue!.id);
    const prodRepositories = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, prodIssue!.id));
    const prodRepositoryByUrl = new Map(prodRepositories.map((repository) => [repository.url, repository]));
    const prodRepository = prodRepositoryByUrl.get(remotes[0])!;
    assert.deepEqual(prodRepositories.map(({ url, baseBranch }) => ({ url, baseBranch })).sort((left, right) => left.url.localeCompare(right.url)), [
      { url: remotes[0], baseBranch: "prod" },
      { url: remotes[1], baseBranch: "develop" },
    ]);
    const [prodWorkspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, prodIssue!.id));
    const [prodSession] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, prodIssue!.id));
    assert.equal(prodRepository!.baseBranch, "prod");
    assert.equal(prodRepository!.workingBranch, null);
    assert.equal(prodRepository!.localPath, null);
    assert.equal(prodWorkspace!.runtimeReady, true);
    assert.equal(prodSession!.workspacePath, issueRuntimeRoot(stateRoot, prodIssue!.key));
    const prodRuntimeName = repositoryWorkspaceNames(remotes).get(remotes[0])!;
    assert.equal(starts[0]!.context.canModifyCode, false);
    assert.equal(sessionStops, 1);
    assert.equal(starts[0]!.workspaceRoot, issueRuntimeRoot(stateRoot, prodIssue!.key));
    assert.equal(path.relative(sharedCheckoutsRoot(stateRoot), await git(["-C", path.join(starts[0]!.workspaceRoot, prodRuntimeName), "rev-parse", "--show-toplevel"])).startsWith(".."), false);
    await assert.rejects(access(issueWorkspaceRoot(stateRoot, prodIssue!.key)));

    const firstProdCommit = prodRepository.commitBefore;
    const firstSecondaryCommit = prodRepositoryByUrl.get(remotes[1])!.commitBefore;
    await writeFile(path.join(source, "README.md"), "new production snapshot\n", "utf8");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "new snapshot"]);
    await git(["-C", source, "push", "origin", "prod"]);
    await internal.run(prodIssue!.id);
    const refreshedProdRepositories = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, prodIssue!.id));
    const refreshedProdRepositoryByUrl = new Map(refreshedProdRepositories.map((repository) => [repository.url, repository]));
    const refreshedProdRepository = refreshedProdRepositoryByUrl.get(remotes[0])!;
    assert.notEqual(refreshedProdRepository.commitBefore, firstProdCommit);
    assert.equal(refreshedProdRepository.commitBefore, await git(["-C", source, "rev-parse", "prod"]));
    assert.equal(refreshedProdRepositoryByUrl.get(remotes[1])!.commitBefore, firstSecondaryCommit);
    assert.equal(sessionStops, 2);

    await internal.run(devIssue!.id);
    const devRepositories = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, devIssue!.id));
    const devRepository = devRepositories.find((repository) => repository.url === remotes[0])!;
    assert.deepEqual(devRepositories.map(({ url, baseBranch }) => ({ url, baseBranch })).sort((left, right) => left.url.localeCompare(right.url)), [
      { url: remotes[0], baseBranch: "develop" },
      { url: remotes[1], baseBranch: "prod" },
    ]);
    const [devWorkspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, devIssue!.id));
    assert.equal(devRepository!.baseBranch, "develop");
    assert.equal(devRepository!.workingBranch, `hotfix-${devIssue!.key.toLowerCase()}`);
    assert.equal(devRepository!.localPath?.startsWith(issueWorkspaceRoot(stateRoot, devIssue!.key)), true);
    assert.equal(await git(["-C", devRepository!.localPath!, "branch", "--show-current"]), devRepository!.workingBranch);
    assert.equal(devWorkspace!.runtimeReady, true);
    assert.equal(starts[2]!.context.canModifyCode, true);

    await database.db.update(serviceDeploymentRepositories).set({ baseBranch: "prod" }).where(and(
      eq(serviceDeploymentRepositories.deploymentId, deployments[1]!.id),
      eq(serviceDeploymentRepositories.repositoryId, repositories[0]!.id),
    ));
    await database.db.update(serviceDeploymentRepositories).set({ baseBranch: "develop" }).where(and(
      eq(serviceDeploymentRepositories.deploymentId, deployments[1]!.id),
      eq(serviceDeploymentRepositories.repositoryId, repositories[1]!.id),
    ));
    await internal.run(devIssue!.id);
    const repeatedDevRepositories = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, devIssue!.id));
    assert.deepEqual(repeatedDevRepositories.map(({ url, baseBranch }) => ({ url, baseBranch })).sort((left, right) => left.url.localeCompare(right.url)), [
      { url: remotes[0], baseBranch: "develop" },
      { url: remotes[1], baseBranch: "prod" },
    ]);

    await engine.close();
    assert.equal(sessionStops, 4);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
