import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { migrate } from "drizzle-orm/libsql/migrator";

import { openDatabase } from "../../src/db/client.ts";
import { environments, serviceDeployments, services } from "../../src/db/schema.ts";
import { useBrowser } from "../../src/evidence/browser.ts";
import { createIssuePolicy } from "../../src/pi/policy.ts";

test("runs scoped Playwright actions without exposing deployment credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-browser-"));
  const databaseFile = join(root, "issues.db");
  const cache = join(root, "tool-cache", "playwright", "node_modules", "playwright-core");
  const workspace = join(root, "workspaces", "issue-20260805-001");
  const previous = { stateRoot: process.env.ISSUE_PILOT_STATE_ROOT, database: process.env.ISSUE_PILOT_DATABASE, cache: process.env.PI_TOOL_CACHE_ROOT };
  try {
    await Promise.all([mkdir(cache, { recursive: true }), mkdir(join(workspace, "repository"), { recursive: true })]);
    await writeFile(join(cache, "package.json"), JSON.stringify({ version: "1.62.1" }), "utf8");
    const database = openDatabase(databaseFile);
    await migrate(database.db, { migrationsFolder: resolve("drizzle") });
    const [environment] = await database.db.insert(environments).values({ organizationId: "demo", scope: "global", key: "development", name: "开发", kind: "development", config: {} }).returning();
    const [service] = await database.db.insert(services).values({ organizationId: "demo", scope: "global", key: "orders", name: "Orders" }).returning();
    const [deployment] = await database.db.insert(serviceDeployments).values({
      serviceId: service!.id,
      environmentId: environment!.id,
      baseBranch: "develop",
      config: { playwright: { baseUrl: "https://orders.example.test/", username: "operator", password: "deployment-secret" } },
    }).returning();
    await database.close();
    delete process.env.ISSUE_PILOT_STATE_ROOT;
    delete process.env.ISSUE_PILOT_DATABASE;
    delete process.env.PI_TOOL_CACHE_ROOT;

    const policy = createIssuePolicy({
      issueKey: "ISSUE-20260805-001",
      issueType: "incident",
      workspaceRoot: workspace,
      service: {
        serviceKey: "orders",
        environmentKey: "development",
        environmentKind: "development",
        capabilities: ["playwright"],
        browser: { deploymentId: deployment!.id, baseUrl: "https://orders.example.test/" },
        repositories: [{ codeAccess: "write", repositoryPath: join(workspace, "repository"), baseCommit: "a".repeat(40) }],
      },
    });
    let command: string[] = [];
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
        return { code: 0, stdout: JSON.stringify({ url: "https://orders.example.test/dashboard", title: "Orders", text: "Ready", controls: [] }), stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI;
    const output = await useBrowser(pi, policy, { actions: [
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
    await assert.rejects(useBrowser(pi, policy, { actions: [{ type: "goto", path: "https://other.example.test/" }] }), /invalid_browser_path/);
  } finally {
    const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
    restore("ISSUE_PILOT_STATE_ROOT", previous.stateRoot);
    restore("ISSUE_PILOT_DATABASE", previous.database);
    restore("PI_TOOL_CACHE_ROOT", previous.cache);
    await rm(root, { recursive: true, force: true });
  }
});
