import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { AgentEngine } from "../../src/agent/engine.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { agentSessions, environments, issueRepositories, issues, issueWorkspaces, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services, subjects } from "../../src/db/schema.ts";
import type { IssuePolicy } from "../../src/pi/policy.ts";
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

test("uses unified code-server runtimes while preserving read-only and writable Agent workspaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-engine-repositories-"));
  const stateRoot = path.join(root, "state");
  const database = await openApplicationDatabase(path.join(stateRoot, "issues.db"));
  const policies: IssuePolicy[] = [];
  const codeServerPaths: string[] = [];
  let sessionStops = 0;
  try {
    const { source, remotes } = await createRemote(root);
    const environmentRows = await database.db.select().from(environments);
    const prod = environmentRows.find((environment) => environment.kind === "prod")!;
    const dev = environmentRows.find((environment) => environment.kind === "dev")!;
    await database.db.insert(subjects).values({ subject: "tester", displayName: "Tester" });
    const [service] = await database.db.insert(services).values({ key: "orders", name: "Orders" }).returning();
    const repositories = await database.db.insert(serviceRepositories).values([
      { serviceId: service!.id, alias: "orders", url: remotes[0] },
      { serviceId: service!.id, alias: "orders-secondary", url: remotes[1] },
    ]).returning();
    const agent = { provider: "test-provider", model: "test-model", thinkingLevel: "medium" as const };
    const deployments = await database.db.insert(serviceDeployments).values([
      { serviceId: service!.id, environmentId: prod.id, config: { agent } },
      { serviceId: service!.id, environmentId: dev.id, config: { agent } },
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
      piRuntime: { start(options: { policy: IssuePolicy }): Promise<unknown> };
      codeServerManager: { ensure(issueKey: string, workspacePath: string): Promise<string> };
      run(issueId: string): Promise<void>;
    };
    internal.piRuntime = {
      async start(options) {
        policies.push(options.policy);
        return { session: {}, streaming: false, async prompt() {}, async stop() { sessionStops += 1; } };
      },
    };
    internal.codeServerManager = {
      async ensure(_issueKey, workspacePath) { codeServerPaths.push(workspacePath); return "http://127.0.0.1:18080"; },
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
    assert.equal(prodWorkspace!.codeServerReady, true);
    assert.equal(prodSession!.workspacePath, issueRuntimeRoot(stateRoot, prodIssue!.key));
    assert.equal(policies[0]!.service.repositories[0]!.codeAccess, "read");
    assert.equal(sessionStops, 1);
    assert.equal(path.relative(sharedCheckoutsRoot(stateRoot), await git(["-C", policies[0]!.service.repositories[0]!.repositoryPath, "rev-parse", "--show-toplevel"])).startsWith(".."), false);
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
    assert.equal(policies[1]!.service.repositories.find((repository) => repository.baseCommit === refreshedProdRepository.commitBefore)?.baseCommit, refreshedProdRepository.commitBefore);
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
    assert.equal(devWorkspace!.codeServerReady, true);
    assert.equal(policies[2]!.service.repositories[0]!.codeAccess, "write");
    assert.deepEqual(codeServerPaths, [
      issueRuntimeRoot(stateRoot, prodIssue!.key),
      issueRuntimeRoot(stateRoot, prodIssue!.key),
      issueRuntimeRoot(stateRoot, devIssue!.key),
    ]);
    await engine.close();
    assert.equal(sessionStops, 3);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
