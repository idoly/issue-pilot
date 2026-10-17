import { registerTestRepositories } from "../helpers/repositories.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { agentSessions, environments, issueRelations, issues, issueWorkspaces, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services, subjects } from "../../src/db/schema.ts";
import { IssueProjectManager } from "../../src/workspace/project.ts";
import { issueRuntimeRoot, issueSessionRoot } from "../../src/workspace/state.ts";

const execFileAsync = promisify(execFile);
const git = async (args: string[]) => (await execFileAsync("git", args, { encoding: "utf8" })).stdout.trim();

async function createRemote(root: string): Promise<string> {
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  await git(["init", "-b", "main", source]);
  await writeFile(path.join(source, "README.md"), "production baseline\n", "utf8");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"]);
  await git(["clone", "--bare", source, remote]);
  return remote;
}

test("adds available metadata, conversations, and development snapshots to a production analysis runtime", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-related-runtime-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const remote = await createRemote(root);
    const [prod] = await database.db.select().from(environments).where(eq(environments.kind, "prod")).limit(1);
    const [dev] = await database.db.select().from(environments).where(eq(environments.kind, "dev")).limit(1);
    await database.db.insert(subjects).values({ subject: "tester", displayName: "Tester" });
    const [service] = await database.db.insert(services).values({ key: "orders", name: "Orders" }).returning();
    await registerTestRepositories(database.db, [remote]);
    const [repository] = await database.db.insert(serviceRepositories).values({ serviceId: service!.id, alias: "orders", url: remote }).returning();
    const deployments = await database.db.insert(serviceDeployments).values([
      { serviceId: service!.id, environmentId: prod!.id, config: {} },
      { serviceId: service!.id, environmentId: dev!.id, config: {} },
    ]).returning();
    await database.db.insert(serviceDeploymentRepositories).values(deployments.map((deployment) => ({ deploymentId: deployment.id, repositoryId: repository!.id, baseBranch: "main" })));
    const [development, relatedProduction, production] = await database.db.insert(issues).values([
      { key: "ISSUE-20260918-101", title: "Development fix", description: "Fix the regression", type: "defect_fix", serviceId: service!.id, environmentId: dev!.id, reporterSubject: "tester" },
      { key: "ISSUE-20260918-102", title: "Earlier production evidence", description: "No development branch or conversation", type: "smart_analysis", serviceId: service!.id, environmentId: prod!.id, reporterSubject: "tester" },
      { key: "ISSUE-20260918-103", title: "Production regression", description: "Investigate with related evidence", type: "smart_analysis", serviceId: service!.id, environmentId: prod!.id, reporterSubject: "tester" },
    ]).returning();
    await database.db.insert(issueWorkspaces).values([{ issueId: development!.id }, { issueId: relatedProduction!.id }, { issueId: production!.id }]);

    const projects = new IssueProjectManager(database.db, root);
    const preparedDevelopment = await projects.prepare(development!, "dev");
    const developmentRepository = preparedDevelopment.repositories[0]!.workspacePath;
    await writeFile(path.join(developmentRepository, "README.md"), "committed development fix\n", "utf8");
    await git(["-C", developmentRepository, "add", "README.md"]);
    await git(["-C", developmentRepository, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "fix regression"]);
    await writeFile(path.join(developmentRepository, "README.md"), "uncommitted local experiment\n", "utf8");

    const sessionRoot = issueSessionRoot(root, development!.key);
    const sessionFile = path.join(sessionRoot, "session.jsonl");
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(sessionFile, "{\"type\":\"custom\",\"customType\":\"issue-pilot-user\",\"data\":{\"message\":\"check the contract\"}}\n", { mode: 0o600 });
    await database.db.insert(agentSessions).values({ issueId: development!.id, sessionFile, workspacePath: preparedDevelopment.workspaceRoot });
    await database.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, development!.id));
    await database.db.insert(issueRelations).values([
      { issueId: production!.id, relatedIssueId: development!.id },
      { issueId: production!.id, relatedIssueId: relatedProduction!.id },
    ]);

    const preparedProduction = await projects.prepare(production!, "prod");
    assert.deepEqual(preparedProduction.relatedIssueKeys.sort(), [development!.key, relatedProduction!.key].sort());
    const relatedRoot = path.join(issueRuntimeRoot(root, production!.key), "related-issues", development!.key.toLowerCase());
    assert.equal(await readFile(path.join(relatedRoot, "repositories", "remote", "README.md"), "utf8"), "committed development fix\n");
    assert.match(await readFile(path.join(relatedRoot, "conversation.jsonl"), "utf8"), /check the contract/);
    const metadata = JSON.parse(await readFile(path.join(relatedRoot, "issue.json"), "utf8")) as { key: string; repositories: Array<{ workingBranch: string; commit: string }> };
    assert.equal(metadata.key, development!.key);
    assert.match(metadata.repositories[0]!.workingBranch, /^hotfix-issue-20260918-101$/);
    assert.match(metadata.repositories[0]!.commit, /^[0-9a-f]{40}$/);
    const metadataOnlyRoot = path.join(issueRuntimeRoot(root, production!.key), "related-issues", relatedProduction!.key.toLowerCase());
    const metadataOnly = JSON.parse(await readFile(path.join(metadataOnlyRoot, "issue.json"), "utf8")) as { key: string; repositories: unknown[]; conversationFile?: string; note: string };
    assert.equal(metadataOnly.key, relatedProduction!.key);
    assert.deepEqual(metadataOnly.repositories, []);
    assert.equal(metadataOnly.conversationFile, undefined);
    assert.match(metadataOnly.note, /No local development branch snapshot/);
    assert.deepEqual(await readdir(path.join(metadataOnlyRoot, "repositories")), []);
    await assert.rejects(readFile(path.join(metadataOnlyRoot, "conversation.jsonl"), "utf8"), (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT");
    assert.equal(await readFile(path.join(preparedProduction.runtimeRoot, "remote", "README.md"), "utf8"), "production baseline\n");

    // Development rounds and cold-start hydration expose the same read-only evidence
    // in runtime without adding unmanaged entries to the writable workspace root.
    await database.db.insert(issueRelations).values({ issueId: development!.id, relatedIssueId: relatedProduction!.id });
    const developmentWithRelations = await projects.prepare(development!, "dev");
    assert.deepEqual(developmentWithRelations.relatedIssueKeys, [relatedProduction!.key]);
    const devEvidence = path.join(developmentWithRelations.runtimeRoot, "related-issues", relatedProduction!.key.toLowerCase(), "issue.json");
    assert.equal(JSON.parse(await readFile(devEvidence, "utf8")).key, relatedProduction!.key);
    assert.deepEqual(await readdir(developmentWithRelations.workspaceRoot), ["remote"]);
    await projects.hydrateDevelopmentRuntime(development!);
    assert.equal(JSON.parse(await readFile(devEvidence, "utf8")).key, relatedProduction!.key);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
