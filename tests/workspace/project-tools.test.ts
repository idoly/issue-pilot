import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { PodmanContainerRuntime } from "../../src/container-runtime.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issueRepositories, issues, serviceDeployments, services, subjects } from "../../src/db/schema.ts";
import type { CommandExecutionOptions, CommandExecutor } from "../../src/capabilities/local-exec.ts";
import { prepareProjectWrappers } from "../../src/workspace/project-wrappers.ts";
import { ProjectToolBroker, type ProjectToolRuntime } from "../../src/workspace/project-tools.ts";
import { issueRuntimeRoot, issueWorkspaceRoot } from "../../src/workspace/state.ts";

const execFileAsync = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-project-tools-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  const [environment] = await database.db.select().from(environments).where(eq(environments.key, "dev")).limit(1);
  assert.ok(environment);
  await database.db.insert(subjects).values({ subject: "tester", displayName: "Tester", email: "tester@example.test" });
  const [service] = await database.db.insert(services).values({ key: "project-tools", name: "Project Tools" }).returning();
  await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment.id, config: {} });
  const [issue] = await database.db.insert(issues).values({
    key: "ISSUE-20260815-001", title: "Project tools", status: "open", priority: "p2", type: "defect_fix",
    serviceId: service!.id, environmentId: environment.id, reporterSubject: "tester",
  }).returning();
  const workspace = issueWorkspaceRoot(root, issue!.key);
  const repository = path.join(workspace, "application");
  await mkdir(repository, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(path.join(repository, "package.json"), JSON.stringify({ packageManager: "npm@11.17.0", scripts: { test: "node --test" } }), { mode: 0o600 }),
    writeFile(path.join(repository, "package-lock.json"), "{}\n", { mode: 0o600 }),
    writeFile(path.join(repository, "pom.xml"), "<project/>\n", { mode: 0o600 }),
  ]);
  await database.db.insert(issueRepositories).values({
    issueId: issue!.id, url: "https://git.example.test/application.git", baseBranch: "main", workingBranch: "hotfix-issue-20260815-001",
    localPath: repository, workspaceName: "application", commitBefore: "a".repeat(40),
  });
  const tools = path.join(root, "operator-tools");
  const npmConfig = path.join(tools, "npmrc");
  const npmCache = path.join(tools, "npm-cache");
  const mavenSettings = path.join(tools, "settings.xml");
  const mavenRepository = path.join(tools, "maven-repository");
  await Promise.all([mkdir(npmCache, { recursive: true, mode: 0o700 }), mkdir(mavenRepository, { recursive: true, mode: 0o700 })]);
  await Promise.all([
    writeFile(npmConfig, "//registry.example.test/:_authToken=fixture-secret\n", { mode: 0o600 }),
    writeFile(mavenSettings, "<settings><servers><server><password>fixture-secret</password></server></servers></settings>\n", { mode: 0o600 }),
  ]);
  const runtime: ProjectToolRuntime = {
    node: { image: "node-image@sha256:fixture", npmConfig, npmCache },
    maven: { image: "maven-image@sha256:fixture", settings: mavenSettings, repository: mavenRepository },
    containerPids: 32, containerMemory: "512m", executionMs: 30_000,
  };
  return { root, database, issue: issue!, repository, runtime };
}

test("runs Agent and Code browser project wrappers through the scoped container broker", async () => {
  const value = await fixture();
  const calls: Array<{ command: string; args: string[]; options: CommandExecutionOptions }> = [];
  const executor: CommandExecutor = {
    async execute(command, args, options = {}) {
      calls.push({ command, args, options });
      return { code: 0, stdout: args.includes(value.runtime.node.image) ? "node-ok\n" : "maven-ok\n", stderr: "", killed: false };
    },
  };
  const containers = new PodmanContainerRuntime(executor);
  const broker = new ProjectToolBroker(value.database.db, value.root, containers, value.runtime);
  try {
    await broker.start();
    assert.equal((await stat(broker.socketPath)).mode & 0o777, 0o600);
    const competing = new ProjectToolBroker(value.database.db, value.root, containers, value.runtime);
    await assert.rejects(competing.start(), /project_tool_broker_already_running/);
    await competing.close();
    assert.equal((await stat(broker.socketPath)).mode & 0o777, 0o600);
    const bin = await prepareProjectWrappers(issueRuntimeRoot(value.root, value.issue.key));
    const node = await execFileAsync(path.join(bin, "node-project"), [value.repository, "test", "--runInBand"]);
    assert.equal(node.stdout, "node-ok\n");
    const maven = await execFileAsync(path.join(bin, "maven-project"), [value.repository, "verify", "-DskipTests"]);
    assert.equal(maven.stdout, "maven-ok\n");

    assert.equal(calls[0]!.command, "podman");
    for (const required of ["--rm", "--read-only", "--network", "host", "--userns", "keep-id", "--pids-limit", "32", "--memory", "512m", "CI=1"]) assert.ok(calls[0]!.args.includes(required));
    assert.ok(calls[0]!.args.includes(`${value.repository}:/workspace:rw,z`));
    assert.ok(calls[0]!.args.includes(`${value.runtime.node.npmConfig}:/run/issue-pilot/npmrc:ro`));
    assert.ok(calls[0]!.args.includes(`${value.runtime.node.npmCache}:/cache/npm:rw,z`));
    assert.deepEqual(calls[0]!.args.slice(calls[0]!.args.indexOf(value.runtime.node.image) + 1), ["npm", "run", "test", "--", "--runInBand"]);
    assert.doesNotMatch(JSON.stringify(calls[0]), /fixture-secret/);

    assert.ok(calls[1]!.args.includes(`${value.runtime.maven.settings}:/run/issue-pilot/maven-settings.xml:ro`));
    assert.ok(calls[1]!.args.includes(`${value.runtime.maven.repository}:/cache/maven:rw,z`));
    assert.deepEqual(calls[1]!.args.slice(calls[1]!.args.indexOf(value.runtime.maven.image) + 1), ["mvn", "--batch-mode", "--no-transfer-progress", "--settings", "/run/issue-pilot/maven-settings.xml", "-Dmaven.repo.local=/cache/maven", "verify", "-DskipTests"]);
    assert.doesNotMatch(JSON.stringify(calls[1]), /fixture-secret/);

    await broker.run({ tool: "node", issueKey: value.issue.key, repository: "application", project: "", action: "install", args: [] });
    assert.deepEqual(calls[2]!.args.slice(calls[2]!.args.indexOf(value.runtime.node.image) + 1), ["npm", "ci"]);
    for (const action of ["start", "dev", "serve", "preview"]) {
      await assert.rejects(broker.run({ tool: "node", issueKey: value.issue.key, repository: "application", project: "", action, args: [] }), /invalid_project_tool_action/);
    }
    for (const argument of ["--watch", "--watchAll", "--watch-mode=all"]) {
      await assert.rejects(broker.run({ tool: "node", issueKey: value.issue.key, repository: "application", project: "", action: "test", args: [argument] }), /invalid_project_tool_argument/);
    }
    assert.equal(calls.length, 3);
    await assert.rejects(broker.run({ tool: "maven", issueKey: value.issue.key, repository: "missing", project: "", action: "test", args: [] }), /workspace_repository_missing/);
    await chmod(value.runtime.node.npmConfig, 0o644);
    await assert.rejects(broker.run({ tool: "node", issueKey: value.issue.key, repository: "application", project: "", action: "test", args: [] }), /insecure_project_tool_configuration/);
  } finally {
    await broker.close().catch(() => undefined);
    await value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
  await assert.rejects(stat(path.join(value.root, "control", "project-tools.sock")), /ENOENT/);
});

test("serializes project containers for the same Issue", async () => {
  const value = await fixture();
  let active = 0;
  let maximum = 0;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const executor: CommandExecutor = {
    async execute() {
      active += 1;
      maximum = Math.max(maximum, active);
      if (maximum === 1) await firstBlocked;
      active -= 1;
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  };
  const broker = new ProjectToolBroker(value.database.db, value.root, new PodmanContainerRuntime(executor), value.runtime);
  const request = { tool: "node" as const, issueKey: value.issue.key, repository: "application", project: "", action: "test", args: [] };
  try {
    const first = broker.run(request);
    while (!active) await new Promise((resolve) => setImmediate(resolve));
    const second = broker.run(request);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(active, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(maximum, 1);
  } finally {
    releaseFirst();
    await value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});
