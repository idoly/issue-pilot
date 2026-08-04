import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../../src/evidence/extension.ts";

const execFileAsync = promisify(execFile);

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

async function repository(root: string): Promise<{ path: string; commit: string }> {
  const repositoryPath = join(root, "repository");
  await mkdir(repositoryPath, { recursive: true });
  await Promise.all([
    writeFile(join(repositoryPath, "application.yml"), [
      "spring:",
      "  datasource:",
      "    url: jdbc:mysql://mysql.example.test:3306/orders",
      "    username: readonly",
      "    password: repository-secret",
      "",
    ].join("\n"), "utf8"),
  ]);
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
  const previous = { connectors: process.env.ISSUE_PILOT_CONNECTORS_FILE, stateRoot: process.env.ISSUE_PILOT_STATE_ROOT };
  try {
    const source = await repository(root);
    await mkdir(join(root, "capabilities"), { recursive: true });
    await mkdir(issueRoot, { recursive: true });
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
    await writeFile(capabilityFile, JSON.stringify({
      issueKey: "ISSUE-20260803-001",
      services: [{
        serviceKey: "orders",
        environmentKey: "test",
        environmentKind: "test",
        repositoryPath: source.path,
        baseCommit: source.commit,
        modulePaths: [],
        capabilities: ["configuration_read", "database_read"],
      }, {
        serviceKey: "orders-production",
        environmentKey: "production",
        environmentKind: "production",
        repositoryPath: source.path,
        baseCommit: source.commit,
        modulePaths: [],
        capabilities: ["database_read"],
      }],
    }), { mode: 0o600 });
    await chmod(capabilityFile, 0o600);
    process.env.ISSUE_PILOT_CONNECTORS_FILE = connectors;
    process.env.ISSUE_PILOT_STATE_ROOT = root;

    const tools = new Map<string, RegisteredTool>();
    const calls: string[][] = [];
    let mysqlStdout = "order_id\tstatus\tpassword\n123\tready\tsecret-value\n";
    const pi = {
      on() {},
      registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
      async exec(command: string, args: string[]) {
        calls.push([command, ...args]);
        if (args.includes("mysql")) return { code: 0, stdout: mysqlStdout, stderr: "", killed: false };
        if (args.includes("ExecuteScript")) return { code: 0, stdout: JSON.stringify({ Result: [{ order_id: "123", status: "ready", password: "production-secret" }] }), stderr: "", killed: false };
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI;
    await extension(pi);
    assert.deepEqual([...tools.keys()].sort(), ["configuration_read", "database_read", "maven_project_command", "node_project_command"]);

    const configuration = await tools.get("configuration_read")!.execute("config", { service_key: "orders" }, undefined, undefined, { cwd: issueRoot });
    assert.match(configuration.content[0]!.text, /spring\.datasource\.url/);
    assert.match(configuration.content[0]!.text, /\[REDACTED\]/);
    assert.doesNotMatch(configuration.content[0]!.text, /repository-secret/);

    delete process.env.ISSUE_PILOT_STATE_ROOT;
    const inferredStateRoot = await tools.get("configuration_read")!.execute("config-inferred", { service_key: "orders" }, undefined, undefined, { cwd: issueRoot });
    assert.match(inferredStateRoot.content[0]!.text, /spring\.datasource\.url/);
    process.env.ISSUE_PILOT_STATE_ROOT = root;

    const database = await tools.get("database_read")!.execute("query", { service_key: "orders", statement: "SELECT order_id, status, password FROM orders WHERE order_id = '123' LIMIT 20" }, undefined, undefined, { cwd: issueRoot });
    assert.match(database.content[0]!.text, /ready/);
    assert.match(database.content[0]!.text, /secret-value/);
    assert.doesNotMatch(database.content[0]!.text, /repository-secret/);
    mysqlStdout = `payload\n${"x".repeat(200_000)}\n`;
    const bounded = await tools.get("database_read")!.execute("query", { service_key: "orders", statement: "SELECT payload FROM audit_log ORDER BY created_at DESC LIMIT 100" }, undefined, undefined, { cwd: issueRoot });
    assert.ok(Buffer.byteLength(bounded.content[0]!.text, "utf8") < 50 * 1024);
    const production = await tools.get("database_read")!.execute("query", { service_key: "orders-production", statement: "SELECT order_id, status FROM orders WHERE order_id = '123' LIMIT 20" }, undefined, undefined, { cwd: issueRoot });
    assert.match(production.content[0]!.text, /"provider": "dms"/);
    assert.match(production.content[0]!.text, /production-secret/);
    assert.doesNotMatch(production.content[0]!.text, /\[REDACTED\]/);
    await assert.rejects(tools.get("database_read")!.execute("query", { service_key: "billing", statement: "SELECT 1 LIMIT 1" }, undefined, undefined, { cwd: issueRoot }), /service_not_granted_for_issue/);
    await assert.rejects(tools.get("database_read")!.execute("query", { service_key: "orders", statement: "UPDATE orders SET status = 'done'" }, undefined, undefined, { cwd: issueRoot }), /database_query_must_be_read_only/);
    await assert.rejects(tools.get("database_read")!.execute("query", { service_key: "orders", statement: "SELECT * FROM orders" }, undefined, undefined, { cwd: issueRoot }), /database_select_requires_limit_at_most_1000/);
    await assert.rejects(tools.get("database_read")!.execute("query", { service_key: "orders", statement: "SELECT * FROM orders INTO OUTFILE '/tmp/orders' LIMIT 10" }, undefined, undefined, { cwd: issueRoot }), /database_query_must_be_read_only/);

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
    await rm(root, { recursive: true, force: true });
  }
});

test("runs fixed Node and Maven Java 8 actions in disposable containers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-toolchains-"));
  const issueRoot = join(root, "issue-20260803-001");
  const nodeProject = join(issueRoot, "web");
  const mavenProject = join(issueRoot, "api");
  await Promise.all([mkdir(nodeProject, { recursive: true }), mkdir(mavenProject, { recursive: true })]);
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
  const previous = process.env.ISSUE_PILOT_CONNECTORS_FILE;
  try {
    process.env.ISSUE_PILOT_CONNECTORS_FILE = join(root, "missing-connectors");
    await extension(pi);
    await tools.get("node_project_command")!.execute("node", { project_path: "web", action: "test" }, undefined, undefined, { cwd: issueRoot });
    await tools.get("maven_project_command")!.execute("maven", { project_path: "api", action: "verify" }, undefined, undefined, { cwd: issueRoot });
    const commandText = calls.map((call) => call.join(" ")).join("\n");
    assert.match(commandText, /podman run --rm .*--workdir \/workspaces\/issue-20260803-001\/web .*node:26.5.1-bookworm-slim npm run test/);
    assert.match(commandText, /podman run --rm .*--workdir \/workspaces\/issue-20260803-001\/api .*maven:3\.9\.16-eclipse-temurin-8 mvn --batch-mode --no-transfer-progress -Dmaven.repo.local=\/tool-cache verify/);
    assert.doesNotMatch(commandText, /vitest run|sh -c|bash -c/);
  } finally {
    if (previous === undefined) delete process.env.ISSUE_PILOT_CONNECTORS_FILE; else process.env.ISSUE_PILOT_CONNECTORS_FILE = previous;
    await rm(root, { recursive: true, force: true });
  }
});
