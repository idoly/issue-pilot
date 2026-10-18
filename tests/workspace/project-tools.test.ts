import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { ProcessToolRuntime } from "../../src/tool-runtime.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issueRepositories, issues, serviceDeployments, services, subjects } from "../../src/db/schema.ts";
import type { CommandExecutionOptions, CommandExecutor } from "../../src/process.ts";
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
    node: { npmConfig, npmCache },
    maven: { settings: mavenSettings, repository: mavenRepository },
    executionMs: 30_000,
  };
  return { root, database, issue: issue!, repository, runtime };
}

test("runs Agent and Code browser project wrappers through the scoped process broker", async () => {
  const value = await fixture();
  const calls: Array<{ command: string; args: string[]; options: CommandExecutionOptions; config: string }> = [];
  const executor: CommandExecutor = {
    async execute(command, args, options = {}) {
      const configPath = command === "npm" ? options.environment!.NPM_CONFIG_USERCONFIG! : args[args.indexOf("--settings") + 1]!;
      calls.push({ command, args, options, config: await readFile(configPath, "utf8") });
      return { code: 0, stdout: command === "npm" ? "node-ok\n" : "maven-ok\n", stderr: "", killed: false };
    },
  };
  const tools = new ProcessToolRuntime(executor);
  const broker = new ProjectToolBroker(value.database.db, value.root, tools, value.runtime);
  try {
    await broker.start();
    assert.equal((await stat(broker.socketPath)).mode & 0o777, 0o600);
    const competing = new ProjectToolBroker(value.database.db, value.root, tools, value.runtime);
    await assert.rejects(competing.start(), /project_tool_broker_already_running/);
    await competing.close();
    assert.equal((await stat(broker.socketPath)).mode & 0o777, 0o600);
    const bin = await prepareProjectWrappers(issueRuntimeRoot(value.root, value.issue.key));
    const node = await execFileAsync(path.join(bin, "node-project"), [value.repository, "test", "--runInBand"]);
    assert.equal(node.stdout, "node-ok\n");
    const maven = await execFileAsync(path.join(bin, "maven-project"), [value.repository, "verify", "-DskipTests"]);
    assert.equal(maven.stdout, "maven-ok\n");

    assert.equal(calls[0]!.command, "npm");
    assert.deepEqual(calls[0]!.args, ["run", "test", "--", "--runInBand"]);
    assert.equal(calls[0]!.options.cwd, value.repository);
    assert.equal(calls[0]!.options.environment!.CI, "1");
    assert.equal(calls[0]!.options.environment!.NPM_CONFIG_CACHE, value.runtime.node.npmCache);
    assert.match(calls[0]!.config, /fixture-secret/);
    assert.doesNotMatch(JSON.stringify({ command: calls[0]!.command, args: calls[0]!.args, options: calls[0]!.options }), /fixture-secret/);

    assert.equal(calls[1]!.command, "mvn");
    assert.deepEqual(calls[1]!.args.slice(0, 3), ["--batch-mode", "--no-transfer-progress", "--settings"]);
    assert.equal(calls[1]!.args[3], value.runtime.maven.settings);
    assert.equal(calls[1]!.args[4], `-Dmaven.repo.local=${value.runtime.maven.repository}`);
    assert.deepEqual(calls[1]!.args.slice(5), ["verify", "-DskipTests"]);
    assert.match(calls[1]!.config, /fixture-secret/);
    assert.doesNotMatch(JSON.stringify({ command: calls[1]!.command, args: calls[1]!.args, options: calls[1]!.options }), /fixture-secret/);

    await broker.run({ tool: "node", issueKey: value.issue.key, repository: "application", project: "", action: "install", args: [] });
    assert.deepEqual(calls[2]!.args, ["ci"]);
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

test("cancels a project command when its HTTP client disconnects after sending the body", async () => {
  const value = await fixture();
  let started!: () => void, canceled!: () => void, finish!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const aborted = new Promise<void>(resolve => { canceled = resolve; });
  const broker = new ProjectToolBroker(value.database.db, value.root, {
    async run(options) {
      started();
      await new Promise<void>(resolve => { finish = resolve; options.signal!.addEventListener("abort", () => { canceled(); resolve(); }, { once: true }); });
      return { stdout: "", stderr: "", code: 1, killed: true };
    },
  }, value.runtime);
  let request: ReturnType<typeof httpRequest> | undefined;
  try {
    await broker.start();
    const fields = ["node", value.issue.key, "application", "", "test"];
    const body = ["issue-pilot-project-tool-v1", ...fields.map(field => Buffer.from(field).toString("base64")), ""].join("\n");
    request = httpRequest({ socketPath: broker.socketPath, path: "/v1/project-tools", method: "POST", headers: { "Content-Type": "application/vnd.issue-pilot.project-tool" } });
    request.on("error", () => {}); request.end(body);
    await running; request.destroy();
    const stopped = await Promise.race([aborted.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 100))]);
    assert.equal(stopped, true);
  } finally { request?.destroy(); finish?.(); await broker.close(); await value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("does not start a queued project command after its caller cancels", async () => {
  const value = await fixture(); let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const broker = new ProjectToolBroker(value.database.db, value.root, { async run() { calls++; if (calls === 1) await gate; return { stdout: "", stderr: "", code: 0, killed: false }; } }, value.runtime);
  const request = { tool: "node" as const, issueKey: value.issue.key, repository: "application", project: "", action: "test", args: [] };
  try {
    const first = broker.run(request);
    while (!calls) await new Promise(resolve => setImmediate(resolve));
    const controller = new AbortController();
    const second = broker.run(request, controller.signal);
    const canceled = assert.rejects(second, { name: "AbortError" });
    controller.abort(); release(); await first; await canceled;
    assert.equal(calls, 1);
  } finally { release(); await broker.close(); await value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("serializes project processes for the same Issue", async () => {
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
  const broker = new ProjectToolBroker(value.database.db, value.root, new ProcessToolRuntime(executor), value.runtime);
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
