import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerIssuePilotExtension } from "../../src/pi/extension.ts";
import { createIssuePolicy } from "../../src/pi/policy.ts";

const execFileAsync = promisify(execFile);

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }> }>;
  renderCall?: (...args: any[]) => { render: (width: number) => string[] };
  renderResult?: (...args: any[]) => { render: (width: number) => string[] };
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
  try {
    await mkdir(issueRoot, { recursive: true });
    const source = await repository(issueRoot);
    const supporting = await repository(issueRoot, "supporting", false);
    const attachmentDirectory = join(root, "attachments", "issue-20260803-001");
    const attachmentPath = join(attachmentDirectory, "request.txt");
    const attachmentContent = "request attachment";
    await mkdir(attachmentDirectory, { recursive: true, mode: 0o700 });
    await writeFile(attachmentPath, attachmentContent, { encoding: "utf8", mode: 0o600 });
    const deploymentConfig = { nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", username: "operator", password: "nacos-secret" }, db: { url: "mysql://mysql.example.test:3306/orders", username: "readonly", password: "db-secret" } };
    const policy = createIssuePolicy({
      issueKey: "ISSUE-20260803-001",
      issueType: "incident",
      workspaceRoot: issueRoot,
      attachments: [{ id: "request-attachment", fileName: "request.txt", mediaType: "text/plain", size: Buffer.byteLength(attachmentContent), sha256: createHash("sha256").update(attachmentContent).digest("hex"), attachmentPath }],
      service: {
        serviceKey: "orders",
        environmentKey: "test",
        environmentKind: "test",
        capabilities: ["nacos", "db"],
        nacos: { deploymentId: "deployment-test", serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP" },
        db: { deploymentId: "deployment-test" },
        repositories: [
          { codeAccess: "write", repositoryPath: source.path, baseCommit: source.commit },
          { codeAccess: "write", repositoryPath: supporting.path, baseCommit: supporting.commit },
        ],
      },
    });

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
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI;
    registerIssuePilotExtension(pi, { policy, deploymentConfig });
    assert.deepEqual([...tools.keys()].sort(), ["attachment_read", "complete_issue", "db", "es", "maven_project_command", "mq", "nacos", "node_project_command", "playwright", "redis", "repository_edit", "repository_find", "repository_grep", "repository_list", "repository_read", "repository_status", "repository_write", "sls"]);
    const context = { cwd: issueRoot, ui: { setStatus() {} } };
    await handlers.get("session_start")!({}, context);
    assert.deepEqual(activeTools, ["repository_read", "repository_grep", "repository_find", "repository_list", "attachment_read", "nacos", "db", "node_project_command", "maven_project_command", "repository_status", "complete_issue"]);
    const complete = tools.get("complete_issue")!;
    await assert.rejects(complete.execute("complete", { outcome: "resolved", summary: "done", evidence: [], changes: [], verification: [], risks: [] }, undefined, undefined, context), /issue_completion_requires_verification/);
    await assert.rejects(complete.execute("complete", { outcome: "needs_human", summary: "review", evidence: [], changes: ["changed code"], verification: [], risks: [] }, undefined, undefined, context), /read_only_environment_cannot_report_code_changes/);
    const completion = await complete.execute("complete", { outcome: "blocked", summary: "missing evidence", evidence: [], changes: [], verification: [], risks: ["cannot confirm"] }, undefined, undefined, context);
    assert.match(completion.content[0]!.text, /complete final user-facing answer/);
    assert.equal("terminate" in completion, false);
    await handlers.get("tool_call")!({ toolName: "repository_read", input: { path: join(source.path, "application.yml") } }, context);
    await assert.rejects(handlers.get("tool_call")!({ toolName: "repository_read", input: { path: join(root, "outside.txt") } }, context), /workspace_path_not_granted/);
    await assert.rejects(handlers.get("tool_call")!({ toolName: "bash", input: { command: "pwd" } }, context), /tool_not_granted_for_issue/);

    const attachment = await tools.get("attachment_read")!.execute("attachment", { attachment_id: "request-attachment" }, undefined, undefined, { cwd: issueRoot });
    assert.match(attachment.content[0]!.text, /request attachment/);
    await assert.rejects(tools.get("attachment_read")!.execute("attachment-missing", { attachment_id: "missing" }, undefined, undefined, { cwd: issueRoot }), /attachment_not_granted_for_issue/);

    const configuration = await tools.get("nacos")!.execute("config", {}, undefined, undefined, { cwd: issueRoot });
    assert.match(configuration.content[0]!.text, /spring\.datasource\.url/);
    assert.match(configuration.content[0]!.text, /"repository": "supporting"/);
    assert.match(configuration.content[0]!.text, /repository-secret|spring\.datasource\.password/);
    const configurationResult = JSON.parse(configuration.content[0]!.text) as { controlledConfiguration: { nacos: Record<string, unknown>; db: Record<string, unknown> } };
    assert.deepEqual(configurationResult.controlledConfiguration, {
      nacos: {
        serverUrl: "https://nacos.example.test",
        namespace: "test",
        group: "DEFAULT_GROUP",
        username: "operator",
        password: "nacos-secret",
      },
      db: {
        url: "mysql://mysql.example.test:3306/orders",
        username: "readonly",
        password: "db-secret",
      },
    });
    assert.equal(configurationResult.controlledConfiguration.db.password, "db-secret");

    const database = await tools.get("db")!.execute("query", { statement: "SELECT order_id, status, password FROM orders WHERE order_id = '123' LIMIT 20" }, undefined, undefined, { cwd: issueRoot });
    assert.match(database.content[0]!.text, /ready/);
    assert.match(database.content[0]!.text, /secret-value/);
    const databaseResult = JSON.parse(database.content[0]!.text) as { connection: { url: string; username: string; password: string } };
    assert.equal(databaseResult.connection.password, "db-secret");
    assert.doesNotMatch(database.content[0]!.text, /repository-secret/);
    mysqlStdout = `payload\n${"x".repeat(200_000)}\n`;
    const completeDatabaseResult = await tools.get("db")!.execute("query", { statement: "SELECT payload FROM audit_log ORDER BY created_at DESC" }, undefined, undefined, { cwd: issueRoot });
    assert.ok(Buffer.byteLength(completeDatabaseResult.content[0]!.text, "utf8") > 200_000);
    const status = await tools.get("repository_status")!.execute("status", { action: "status" }, undefined, undefined, { cwd: issueRoot });
    assert.match(status.content[0]!.text, /"repository": "repository"/);
    assert.match(status.content[0]!.text, /"repository": "supporting"/);
    await assert.rejects(tools.get("db")!.execute("query", { statement: "UPDATE orders SET status = 'done'" }, undefined, undefined, { cwd: issueRoot }), /database_query_must_be_read_only/);
    const allRows = await tools.get("db")!.execute("query", { statement: "SELECT * FROM orders" }, undefined, undefined, { cwd: issueRoot });
    assert.match(allRows.content[0]!.text, /payload/);
    await assert.rejects(tools.get("db")!.execute("query", { statement: "SELECT * FROM orders INTO OUTFILE '/tmp/orders' LIMIT 10" }, undefined, undefined, { cwd: issueRoot }), /database_query_must_be_read_only/);

    const commandText = calls.map((call) => call.join(" ")).join("\n");
    assert.match(commandText, /podman run --rm/);
    assert.match(commandText, /mysql:26\.7\.0 mysql/);
    assert.match(commandText, /--default-character-set=utf8mb4/);
    assert.doesNotMatch(commandText, /repository-secret|secret-value|sh -c|bash -c/);
    await handlers.get("session_shutdown")!({}, context);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runs fixed Node and Maven Java 8 actions in disposable containers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-toolchains-"));
  const issueRoot = join(root, "workspaces", "issue-20260803-001");
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
  try {
    const policy = createIssuePolicy({
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
    });
    registerIssuePilotExtension(pi, { policy, deploymentConfig: {} });
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
    await rm(root, { recursive: true, force: true });
  }
});
