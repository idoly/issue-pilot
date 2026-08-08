import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { useBrowser } from "../../src/capabilities/browser.ts";
import type { CommandExecutor } from "../../src/capabilities/local-exec.ts";
import { createIssuePolicy } from "../../src/pi/policy.ts";

test("runs scoped Playwright actions without exposing deployment credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-browser-"));
  const cache = join(root, "tools", "playwright", "node_modules", "playwright-core");
  const workspace = join(root, "workspaces", "issue-20260805-001");
  const previous = { stateRoot: process.env.ISSUE_PILOT_STATE_ROOT, cache: process.env.PI_TOOL_CACHE_ROOT };
  try {
    await Promise.all([mkdir(cache, { recursive: true }), mkdir(join(workspace, "repository"), { recursive: true })]);
    await writeFile(join(cache, "package.json"), JSON.stringify({ version: "1.62.1" }), "utf8");
    delete process.env.ISSUE_PILOT_STATE_ROOT;
    delete process.env.PI_TOOL_CACHE_ROOT;

    const policy = createIssuePolicy({
      issueKey: "ISSUE-20260805-001",
      issueType: "defect_fix",
      workspaceRoot: workspace,
      model: { provider: "test", modelId: "test-model", thinkingLevel: "medium" },
      service: {
        serviceKey: "orders",
        environmentKey: "dev",
        environmentKind: "dev",
        capabilities: ["playwright"],
        browser: { deploymentId: "deployment-browser", baseUrl: "https://orders.example.test/" },
        repositories: [{ codeAccess: "write", repositoryPath: join(workspace, "repository"), baseCommit: "a".repeat(40) }],
      },
    });
    let command: string[] = [];
    let response: Record<string, unknown> = { url: "https://orders.example.test/dashboard", title: "Orders", text: "Ready", controls: [] };
    let mountedRequest = "";
    let mountedCredentials = "";
    const pi = {
      async exec(executable: string, args: string[]) {
        command = [executable, ...args];
        const mounts = args.flatMap((value, index) => args[index - 1] === "--volume" ? [value] : []);
        const requestDirectory = mounts.find((value) => value.includes(":/run/input:"))!.split(":/run/input:")[0]!;
        const secretDirectory = mounts.find((value) => value.includes(":/run/secrets:"))!.split(":/run/secrets:")[0]!;
        mountedRequest = await readFile(join(requestDirectory, "request.json"), "utf8");
        mountedCredentials = await readFile(join(secretDirectory, "credentials.json"), "utf8");
        return { code: 0, stdout: JSON.stringify(response), stderr: "", killed: false };
      },
    } as CommandExecutor;
    const deploymentConfig = { playwright: { baseUrl: "https://orders.example.test/", username: "operator", password: "deployment-secret" } };
    const output = await useBrowser(pi, policy, deploymentConfig, { actions: [
      { type: "goto", path: "/login" },
      { type: "login", usernameSelector: "#username", passwordSelector: "#password", submitSelector: "button[type=submit]" },
    ] });
    assert.match(mountedRequest, /"path":"\/login"/);
    assert.match(mountedCredentials, /deployment-secret/);
    assert.match(command.join(" "), /--userns keep-id/);
    assert.match(command.join(" "), /mcr\.microsoft\.com\/playwright:v1\.62\.1-noble/);
    assert.doesNotMatch(command.join(" "), /deployment-secret|operator/);
    assert.doesNotMatch(JSON.stringify(output), /deployment-secret|operator/);
    assert.match(output.content[0]!.text, /Ready/);
    const requestMount = command.find((value) => value.includes(":/run/input:"))!.split(":/run/input:")[0]!;
    await assert.rejects(stat(requestMount));
    await assert.rejects(useBrowser(pi, policy, deploymentConfig, { actions: [{ type: "goto", path: "https://other.example.test/" }] }), /invalid_browser_path/);
    response = { screenshot: Buffer.alloc(1024 * 1024).toString("base64") };
    await assert.rejects(useBrowser(pi, policy, deploymentConfig, { actions: [{ type: "goto", path: "/dashboard" }], screenshot: true }), /capability_result_too_large/);
  } finally {
    const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
    restore("ISSUE_PILOT_STATE_ROOT", previous.stateRoot);
    restore("PI_TOOL_CACHE_ROOT", previous.cache);
    await rm(root, { recursive: true, force: true });
  }
});
