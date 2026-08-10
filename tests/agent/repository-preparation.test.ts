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
import { agentSessions, environments, issueRepositories, issues, issueWorkspaces, serviceDeployments, serviceRepositories, services, subjects } from "../../src/db/schema.ts";
import type { IssuePolicy } from "../../src/pi/policy.ts";
import { issueRuntimeRoot, issueWorkspaceRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { encoding: "utf8" })).stdout.trim();
}

async function createRemote(root: string): Promise<{ source: string; remote: string }> {
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  await git(["init", "-b", "prod", source]);
  await writeFile(path.join(source, "README.md"), "production baseline\n", "utf8");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"]);
  await git(["-C", source, "branch", "develop"]);
  await git(["clone", "--bare", source, remote]);
  await git(["-C", source, "remote", "add", "origin", remote]);
  return { source, remote };
}

test("uses shared runtimes for prod and configured issue workspaces for dev", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-engine-repositories-"));
  const stateRoot = path.join(root, "state");
  const database = await openApplicationDatabase(path.join(stateRoot, "issues.db"));
  const policies: IssuePolicy[] = [];
  let codeServerCalls = 0;
  let sessionStops = 0;
  try {
    const { source, remote } = await createRemote(root);
    const environmentRows = await database.db.select().from(environments);
    const prod = environmentRows.find((environment) => environment.kind === "prod")!;
    const dev = environmentRows.find((environment) => environment.kind === "dev")!;
    await database.db.insert(subjects).values({ subject: "tester", displayName: "Tester" });
    const [service] = await database.db.insert(services).values({ key: "orders", name: "Orders" }).returning();
    await database.db.insert(serviceRepositories).values({ serviceId: service!.id, url: remote });
    const agent = { provider: "test-provider", model: "test-model", thinkingLevel: "medium" as const };
    await database.db.insert(serviceDeployments).values([
      { serviceId: service!.id, environmentId: prod.id, baseBranch: "prod", config: { agent } },
      { serviceId: service!.id, environmentId: dev.id, baseBranch: "develop", config: { agent } },
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
      async ensure() { codeServerCalls += 1; return "http://127.0.0.1:18080"; },
    };

    await internal.run(prodIssue!.id);
    const [prodRepository] = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, prodIssue!.id));
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

    const firstProdCommit = prodRepository!.commitBefore;
    await writeFile(path.join(source, "README.md"), "new production snapshot\n", "utf8");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "new snapshot"]);
    await git(["-C", source, "push", "origin", "prod"]);
    await internal.run(prodIssue!.id);
    const [refreshedProdRepository] = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, prodIssue!.id));
    assert.notEqual(refreshedProdRepository!.commitBefore, firstProdCommit);
    assert.equal(refreshedProdRepository!.commitBefore, await git(["-C", source, "rev-parse", "prod"]));
    assert.equal(policies[1]!.service.repositories[0]!.baseCommit, refreshedProdRepository!.commitBefore);
    assert.equal(sessionStops, 2);

    await internal.run(devIssue!.id);
    const [devRepository] = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, devIssue!.id));
    const [devWorkspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, devIssue!.id));
    assert.equal(devRepository!.baseBranch, "develop");
    assert.equal(devRepository!.workingBranch, `hotfix-${devIssue!.key.toLowerCase()}`);
    assert.equal(devRepository!.localPath?.startsWith(issueWorkspaceRoot(stateRoot, devIssue!.key)), true);
    assert.equal(await git(["-C", devRepository!.localPath!, "branch", "--show-current"]), devRepository!.workingBranch);
    assert.equal(devWorkspace!.codeServerReady, true);
    assert.equal(policies[2]!.service.repositories[0]!.codeAccess, "write");
    assert.equal(codeServerCalls, 3);
    await engine.close();
    assert.equal(sessionStops, 3);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
