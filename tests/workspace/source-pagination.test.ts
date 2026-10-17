import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issueRepositories, issues, issueWorkspaces, serviceDeployments, services, subjects } from "../../src/db/schema.ts";
import { executeLocalCommand, type CommandExecutor } from "../../src/process.ts";
import { SourceBrowser } from "../../src/workspace/source-browser.ts";
import { prepareIssueRuntime } from "../../src/workspace/runtime.ts";
import { issueWorkspaceRoot } from "../../src/workspace/state.ts";
import { registerSourceBrowserRoutes } from "../../src/http/source-browser-routes.ts";
import { TestAgentController } from "../http/fixture.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-source-pages-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "dev"));
  await database.db.insert(subjects).values({ subject: "browser-test" });
  const [service] = await database.db.insert(services).values({ key: "source-pages", name: "Source pages" }).returning();
  await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
  const [issue] = await database.db.insert(issues).values({ key: "ISSUE-20261017-991", title: "Synthetic source", type: "defect_fix", serviceId: service!.id, environmentId: environment!.id, reporterSubject: "browser-test" }).returning();
  const repository = path.join(issueWorkspaceRoot(root, issue!.key), "application");
  await mkdir(repository, { recursive: true });
  const git = async (args: string[]) => {
    const result = await executeLocalCommand("git", ["-C", repository, ...args]);
    assert.equal(result.code, 0, result.stderr); return result.stdout.trim();
  };
  await git(["init", "--initial-branch=hotfix-issue-20261017-991"]);
  await database.db.insert(issueRepositories).values({ issueId: issue!.id, url: "https://example.test/source-pages.git", baseBranch: "main", workingBranch: "hotfix-issue-20261017-991", localPath: repository, workspaceName: "application", commitBefore: "a".repeat(40) });
  await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", runtimeReady: true });
  await prepareIssueRuntime(root, issue!.key, [{ name: "application", repositoryPath: repository }], "write");
  return { root, database, issue: issue!, repository, git, browser: new SourceBrowser(database.db, root), close: async () => { database.close(); await rm(root, { recursive: true, force: true }); } };
}

test("paginates a pinned history without losing or repeating commits when HEAD advances", async () => {
  const f = await fixture();
  try {
    const count = issuePilotConfig.limits.sourceBrowser.historyCommits + 25;
    for (let index = 0; index < count; index++) await f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", `Commit ${index}`]);
    const first = await f.browser.history(f.issue, "application");
    assert.equal(first.commits.length, issuePilotConfig.limits.sourceBrowser.historyCommits); assert.ok(first.nextCursor);
    await f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Arrived during pagination"]);
    const second = await f.browser.history(f.issue, "application", "", first.nextCursor);
    assert.equal(second.commits.length, 25); assert.equal(second.nextCursor, null);
    const combined = [...first.commits, ...second.commits];
    assert.equal(new Set(combined.map(commit => commit.hash)).size, count);
    assert.equal(combined.some(commit => commit.subject === "Arrived during pagination"), false);
    assert.equal(second.commits.at(-1)?.subject, "Commit 0");
    await assert.rejects(f.browser.history(f.issue, "application", "", { revision: "invalid", offset: 1 }), /invalid_source_history_cursor/);
    await assert.rejects(f.browser.history(f.issue, "application", "", { revision: first.nextCursor.revision, offset: -1 }), /invalid_source_history_cursor/);
  } finally { await f.close(); }
});

test("bounds a broad AI search and reports the remaining results explicitly", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repository, "many.txt"), "AI await detail main\n".repeat(50_000));
    const result = await f.browser.search(f.issue, "application", "AI", { caseSensitive: false });
    assert.equal(result.matches.length, issuePilotConfig.limits.sourceBrowser.searchMatches);
    assert.equal(result.truncated, true);
    assert.equal(result.matches[0]?.column, 1);
    assert.equal(result.matches.at(-1)?.line, issuePilotConfig.limits.sourceBrowser.searchMatches);
  } finally { await f.close(); }
});

test("cancels the running search process when the HTTP client disconnects", { timeout: 10_000 }, async () => {
  const f = await fixture(), app = Fastify({ logger: false });
  let entered!: () => void, cancelled!: () => void;
  const running = new Promise<void>(resolve => { entered = resolve; }), stopped = new Promise<void>(resolve => { cancelled = resolve; });
  const executor: CommandExecutor = { execute: async (_command, _args, options) => new Promise(resolve => {
    const stop = () => { cancelled(); resolve({ code: 1, killed: true, stdout: "", stderr: "" }); };
    options!.signal!.addEventListener("abort", stop, { once: true }); entered();
    if (options!.signal!.aborted) stop();
  }) };
  registerSourceBrowserRoutes({ app, database: f.database, engine: new TestAgentController(), sourceBrowser: new SourceBrowser(f.database.db, f.root, executor) });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 }), controller = new AbortController();
    const request = fetch(`${address}/api/issues/${f.issue.key}/source/search`, { headers: { "X-Issue-Pilot-Repository": "application", "X-Issue-Pilot-Query": "AI" }, signal: controller.signal });
    const rejected = assert.rejects(request, { name: "AbortError" });
    await running; controller.abort(); await rejected; await stopped;
  } finally { await app.close(); await f.close(); }
});
