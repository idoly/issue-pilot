import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../../src/pi/extension.ts";
import { createIssuePolicy } from "../../src/pi/policy.ts";

const execFileAsync = promisify(execFile);

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

async function repository(root: string, name = "repository", datasource = true): Promise<{ path: string; commit: string }> {
  const repositoryPath = join(root, name);
  await mkdir(repositoryPath, { recursive: true });
  await writeFile(join(repositoryPath, datasource ? "application.yml" : "README.md"), datasource ? [
    "spring:",
    "  datasource:",
    "    url: jdbc:mysql://mysql.example.test:3306/orders",
    "    username: readonly",
    "    password: repository-secret",
    "",
  ].join("\n") : "Supporting repository without a datasource.\n", "utf8");
  await execFileAsync("git", ["init", repositoryPath]);
  await execFileAsync("git", ["-C", repositoryPath, "add", "."]);
  await execFileAsync("git", ["-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "fixture"]);
  const { stdout } = await execFileAsync("git", ["-C", repositoryPath, "rev-parse", "HEAD"], { encoding: "utf8" });
  return { path: repositoryPath, commit: stdout.trim() };
}

test("registers capability tools and resolves frozen service configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-capability-extension-"));
  const issueRoot = join(root, "workspaces", "issue-20260803-001");
  const connectors = join(root, "connectors.json");
  const previous = { connectors: process.env.ISSUE_PILOT_CONNECTORS_FILE, stateRoot: process.env.ISSUE_PILOT_STATE_ROOT, policyRequired: process.env.ISSUE_PILOT_POLICY_REQUIRED };
  try {
    await mkdir(join(root, "capabilities"), { recursive: true });
    await mkdir(issueRoot, { recursive: true });
    const source = await repository(issueRoot);
    const supporting = await repository(issueRoot, "supporting", false);
    const aliyunProfiles = join(root, "aliyun-profiles");
    await mkdir(aliyunProfiles, { recursive: true, mode: 0o700 });
    await chmod(aliyunProfiles, 0o700);
    await writeFile(connectors, JSON.stringify({
      databaseProviders: {
        production: {
          provider: "dms",
          image: "registry.example.test/aliyun-cli:1.0.0",
          profileRoot: aliyunProfiles,
          profile: "production-readonly",
          region: "cn-hangzhou",
          databases: [{ host: "mysql.example.test", database: "orders", dbId: 42 }],
        },
      },
    }), "utf8");
    const capabilityFile = join(root, "capabilities", "issue-20260803-001.json");
    await writeFile(capabilityFile, JSON.stringify(createIssuePolicy({
      issueKey: "ISSUE-20260803-001",
      issueType: "incident",
      workspaceRoot: issueRoot,
      service: {
        serviceKey: "orders",
        environmentKey: "test",
        environmentKind: "test",
        capabilities: ["configuration_read", "database_read"],
        repositories: [
          { codeAccess: "write", repositoryPath: source.path, baseCommit: source.commit },
          { codeAccess: "write", repositoryPath: supporting.path, baseCommit: supporting.commit },
        ],
      },
    })), { mode: 0o600 });
    await chmod(capabilityFile, 0o600);
    process.env.ISSUE_PILOT_CONNECTORS_FILE = connectors;
    process.env.ISSUE_PILOT_STATE_ROOT = root;
    process.env.ISSUE_PILOT_POLICY_REQUIRED = "1";

    const tools = new Map<string, RegisteredTool>();
    const handlers = new Map<string, (...args: any[]) => any>();
    const calls: string[][] = [];
    let activeTools: string[] = [];
    let mysqlStdout = "order_id\tstatus\tpassword\n123\tready\tsecret-value\n";
    const pi = {
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
      setActiveTools(names: string[]) { activeTools = names; },
      registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
      async exec(command: string, args: string[]) {
        calls.push([command, ...args]);
        if (args.includes("mysql")) return { code: 0, stdout: mysqlStdout, stderr: "", killed: false };
        if (args.includes("ExecuteScript")) return { code: 0, stdout: JSON.stringify({ Result: [{ order_id: "123", status: "ready", password: "production-secret" }] }), stderr: "", killed: false };
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI;
    await extension(pi);
    assert.deepEqual([...tools.keys()].sort(), ["configuration_read", "database_read", "maven_project_command", "node_project_command", "repository_status"]);
    const context = { cwd: issueRoot, ui: { setStatus() {} } };
    await handlers.get("session_start")!({}, context);
    assert.deepEqual(activeTools, ["read", "grep", "find", "ls", "edit", "write", "configuration_read", "database_read", "node_project_command", "maven_project_command", "repository_status"]);
    await handlers.get("tool_call")!({ toolName: "read", input: { path: join(source.path, "application.yml") } }, context);
    await assert.rejects(handlers.get("tool_call")!({ toolName: "read", input: { path: connectors } }, context), /workspace_path_not_granted/);
    await assert.rejects(handlers.get("tool_call")!({ toolName: "bash", input: { command: "pwd" } }, context), /tool_not_granted_for_issue/);

    const configuration = await tools.get("configuration_read")!.execute("config", {}, undefined, undefined, { cwd: issueRoot });
    assert.match(configuration.content[0]!.text, /spring\.datasource\.url/);
    assert.match(configuration.content[0]!.text, /"repository": "supporting"/);
    assert.match(configuration.content[0]!.text, /\[REDACTED\]/);
    assert.doesNotMatch(configuration.content[0]!.text, /repository-secret/);

    delete process.env.ISSUE_PILOT_STATE_ROOT;
    const inferredStateRoot = await tools.get("configuration_read")!.execute("config-inferred", {}, undefined, undefined, { cwd: issueRoot });
    assert.match(inferredStateRoot.content[0]!.text, /spring\.datasource\.url/);
    process.env.ISSUE_PILOT_STATE_ROOT = root;

    const database = await tools.get("database_read")!.execute("query", { statement: "SELECT order_id, status, password FROM orders WHERE order_id = '123' LIMIT 20" }, undefined, undefined, { cwd: issueRoot });
    assert.match(database.content[0]!.text, /ready/);
    assert.match(database.content[0]!.text, /secret-value/);
    assert.doesNotMatch(database.content[0]!.text, /repository-secret/);
    mysqlStdout = `payload\n${"x".repeat(200_000)}\n`;
    const bounded = await tools.get("database_read")!.execute("query", { statement: "SELECT payload FROM audit_log ORDER BY created_at DESC LIMIT 100" }, undefined, undefined, { cwd: issueRoot });
    assert.ok(Buffer.byteLength(bounded.content[0]!.text, "utf8") < 50 * 1024);
    const status = await tools.get("repository_status")!.execute("status", { action: "status" }, undefined, undefined, { cwd: issueRoot });
    assert.match(status.content[0]!.text, /"repository": "repository"/);
    assert.match(status.content[0]!.text, /"repository": "supporting"/);
    await writeFile(capabilityFile, JSON.stringify(createIssuePolicy({
      issueKey: "ISSUE-20260803-001",
      issueType: "question",
      workspaceRoot: issueRoot,
      service: {
        serviceKey: "orders",
        environmentKey: "production",
        environmentKind: "production",
        capabilities: ["database_read"],
        repositories: [{ codeAccess: "read", repositoryPath: source.path, baseCommit: source.commit }],
      },
    })), { mode: 0o600 });
    const production = await tools.get("database_read")!.execute("query", { statement: "SELECT order_id, status FROM orders WHERE order_id = '123' LIMIT 20" }, undefined, undefined, { cwd: issueRoot });
    assert.match(production.content[0]!.text, /"provider": "dms"/);
    assert.match(production.content[0]!.text, /production-secret/);
    assert.doesNotMatch(production.content[0]!.text, /\[REDACTED\]/);
    await assert.rejects(tools.get("database_read")!.execute("query", { statement: "UPDATE orders SET status = 'done'" }, undefined, undefined, { cwd: issueRoot }), /database_query_must_be_read_only/);
    await assert.rejects(tools.get("database_read")!.execute("query", { statement: "SELECT * FROM orders" }, undefined, undefined, { cwd: issueRoot }), /database_select_requires_limit_at_most_1000/);
    await assert.rejects(tools.get("database_read")!.execute("query", { statement: "SELECT * FROM orders INTO OUTFILE '/tmp/orders' LIMIT 10" }, undefined, undefined, { cwd: issueRoot }), /database_query_must_be_read_only/);

    const commandText = calls.map((call) => call.join(" ")).join("\n");
    assert.match(commandText, /podman run --rm/);
    assert.match(commandText, /mysql:26\.7\.0 mysql/);
    assert.match(commandText, /--default-character-set=utf8mb4/);
    assert.match(commandText, /registry\.example\.test\/aliyun-cli:1\.0\.0 aliyun --profile production-readonly dms-enterprise ExecuteScript/);
    assert.match(commandText, /--DbId 42/);
    assert.doesNotMatch(commandText, /repository-secret|secret-value|sh -c|bash -c/);
  } finally {
    const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
    restore("ISSUE_PILOT_CONNECTORS_FILE", previous.connectors);
    restore("ISSUE_PILOT_STATE_ROOT", previous.stateRoot);
    restore("ISSUE_PILOT_POLICY_REQUIRED", previous.policyRequired);
    await rm(root, { recursive: true, force: true });
  }
});

test("runs fixed Node and Maven Java 8 actions in disposable containers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-toolchains-"));
  const issueRoot = join(root, "workspaces", "issue-20260803-001");
  const nodeProject = join(issueRoot, "web");
  const mavenProject = join(issueRoot, "api");
  await Promise.all([mkdir(nodeProject, { recursive: true }), mkdir(mavenProject, { recursive: true }), mkdir(join(root, "capabilities"), { recursive: true })]);
  await Promise.all([
    writeFile(join(nodeProject, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8"),
    writeFile(join(mavenProject, "pom.xml"), "<project/>", "utf8"),
  ]);
  const tools = new Map<string, RegisteredTool>();
  const calls: string[][] = [];
  const pi = {
    on() {},
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
    async exec(command: string, args: string[]) { calls.push([command, ...args]); return { code: 0, stdout: "ok", stderr: "", killed: false }; },
  } as unknown as ExtensionAPI;
  const previous = { connectors: process.env.ISSUE_PILOT_CONNECTORS_FILE, stateRoot: process.env.ISSUE_PILOT_STATE_ROOT, policyRequired: process.env.ISSUE_PILOT_POLICY_REQUIRED };
  try {
    await writeFile(join(root, "capabilities", "issue-20260803-001.json"), JSON.stringify(createIssuePolicy({
      issueKey: "ISSUE-20260803-001",
      issueType: "incident",
      workspaceRoot: issueRoot,
      service: {
        serviceKey: "application",
        environmentKey: "test",
        environmentKind: "test",
        capabilities: [],
        repositories: [
          { codeAccess: "write", repositoryPath: nodeProject, baseCommit: "a".repeat(40) },
          { codeAccess: "write", repositoryPath: mavenProject, baseCommit: "b".repeat(40) },
        ],
      },
    })), { mode: 0o600 });
    process.env.ISSUE_PILOT_CONNECTORS_FILE = join(root, "missing-connectors");
    process.env.ISSUE_PILOT_STATE_ROOT = root;
    process.env.ISSUE_PILOT_POLICY_REQUIRED = "1";
    await extension(pi);
    await tools.get("node_project_command")!.execute("node", { project_path: "web", action: "test" }, undefined, undefined, { cwd: issueRoot });
    await tools.get("maven_project_command")!.execute("maven", { project_path: "api", action: "verify" }, undefined, undefined, { cwd: issueRoot });
    const commandText = calls.map((call) => call.join(" ")).join("\n");
    assert.doesNotMatch(commandText, new RegExp(`--volume ${nodeProject}:/workspace`));
    assert.doesNotMatch(commandText, new RegExp(`--volume ${mavenProject}:/workspace`));
    assert.match(commandText, /--volume \/tmp\/issue-pilot-node-[^ ]+\/repository:\/workspace:Z --workdir \/workspace/);
    assert.match(commandText, /--volume \/tmp\/issue-pilot-maven-[^ ]+\/repository:\/workspace:Z --workdir \/workspace/);
    assert.match(commandText, /node:26\.5\.1-bookworm-slim npm run test/);
    assert.match(commandText, /maven:3\.9\.16-eclipse-temurin-8 mvn --batch-mode --no-transfer-progress -Dmaven.repo.local=\/tool-cache verify/);
    assert.doesNotMatch(commandText, /vitest run|sh -c|bash -c/);
  } finally {
    const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
    restore("ISSUE_PILOT_CONNECTORS_FILE", previous.connectors);
    restore("ISSUE_PILOT_STATE_ROOT", previous.stateRoot);
    restore("ISSUE_PILOT_POLICY_REQUIRED", previous.policyRequired);
    await rm(root, { recursive: true, force: true });
  }
});
