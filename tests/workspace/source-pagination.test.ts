import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

test("saves long ASCII and Unicode file names using bounded temporary names", async () => {
  const f = await fixture();
  try {
    for (const name of [`${"a".repeat(240)}.txt`, `${"文".repeat(80)}.txt`]) {
      const created = await f.browser.createFile(f.issue, "application", name, "old contents");
      const saved = await f.browser.writeFile(f.issue, "application", name, "new contents", created.sha256);
      assert.equal(saved.content, "new contents");
      assert.equal((await f.browser.file(f.issue, "application", name)).content, "new contents");
      await assert.rejects(f.browser.writeFile(f.issue, "application", name, "stale contents", created.sha256), /source_file_changed/);
    }
    assert.equal((await readdir(f.repository)).some(name => name.startsWith(".issue-pilot-")), false);
  } finally { await f.close(); }
});

for (const directory of [false, true]) test(`preserves an overwritten ${directory ? "directory" : "file"} when the source cannot be renamed`, { skip: process.getuid?.() === 0 }, async () => {
  const f = await fixture();
  const protectedDirectory = path.join(f.repository, "protected");
  try {
    await mkdir(protectedDirectory);
    await writeFile(path.join(protectedDirectory, "source.txt"), "source data\n");
    const destination = path.join(f.repository, "destination");
    if (directory) await mkdir(destination);
    const evidence = directory ? path.join(destination, "evidence.txt") : destination;
    await writeFile(evidence, "preserve old destination\n");
    await chmod(protectedDirectory, 0o500);
    await assert.rejects(f.browser.renamePath(f.issue, "application", "protected/source.txt", "destination", true), { code: "EACCES" });
    assert.equal(await readFile(evidence, "utf8"), "preserve old destination\n");
    assert.equal(await readFile(path.join(protectedDirectory, "source.txt"), "utf8"), "source data\n");
    assert.equal((await readdir(f.repository)).some(name => name.includes(".issue-pilot-")), false);
  } finally { await chmod(protectedDirectory, 0o700).catch(() => {}); await f.close(); }
});

test("reports rename finalization failures and preserves the previous destination as recovery evidence", { skip: process.getuid?.() === 0 }, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repository, "source"), "new contents\n");
    await mkdir(path.join(f.repository, "destination"));
    await writeFile(path.join(f.repository, "destination", "evidence.txt"), "old contents\n");
    await chmod(path.join(f.repository, "destination"), 0o500);
    await assert.rejects(f.browser.renamePath(f.issue, "application", "source", "destination", true), /source_rename_finalize_failed/);
    assert.equal(await readFile(path.join(f.repository, "destination"), "utf8"), "new contents\n");
    const [backup] = (await readdir(f.repository)).filter(name => name.startsWith(".issue-pilot-rename-"));
    assert.ok(backup);
    assert.equal(await readFile(path.join(f.repository, backup, "evidence.txt"), "utf8"), "old contents\n");
  } finally {
    for (const name of await readdir(f.repository)) if (name.startsWith(".issue-pilot-rename-") || name === "destination") await chmod(path.join(f.repository, name), 0o700).catch(() => {});
    await f.close();
  }
});

test("replaces a nonempty source directory only after installing its replacement", async () => {
  const f = await fixture();
  try {
    for (const name of ["source", "destination"]) {
      await mkdir(path.join(f.repository, name));
      await writeFile(path.join(f.repository, name, "value.txt"), name);
    }
    await f.browser.renamePath(f.issue, "application", "source", "destination", true);
    assert.equal(await readFile(path.join(f.repository, "destination", "value.txt"), "utf8"), "source");
    await assert.rejects(lstat(path.join(f.repository, "source")), { code: "ENOENT" });
    assert.equal((await readdir(f.repository)).some(name => name.includes(".issue-pilot-")), false);
  } finally { await f.close(); }
});

for (const operation of ["delete", "rename"] as const) test(`${operation}s source symlinks without changing their targets`, async () => {
  const f = await fixture();
  try {
    const target = path.join(f.repository, "target.txt");
    const link = path.join(f.repository, "link.txt");
    await writeFile(target, "preserve target\n");
    await symlink("target.txt", link);
    if (operation === "delete") {
      await f.browser.deletePath(f.issue, "application", "link.txt", false);
      await assert.rejects(lstat(link), { code: "ENOENT" });
    } else {
      await f.browser.renamePath(f.issue, "application", "link.txt", "renamed-link.txt", false);
      assert.equal(await readlink(path.join(f.repository, "renamed-link.txt")), "target.txt");
      await assert.rejects(lstat(link), { code: "ENOENT" });
    }
    assert.equal(await readFile(target, "utf8"), "preserve target\n");
    await symlink("missing.txt", path.join(f.repository, "dangling-link"));
    await f.browser.deletePath(f.issue, "application", "dangling-link", false);
    await assert.rejects(lstat(path.join(f.repository, "dangling-link")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("rejects source reads through aliases to Git control paths", async () => {
  const f = await fixture();
  try {
    await symlink(".git", path.join(f.repository, "control-alias"));
    await symlink(".git/config", path.join(f.repository, "config-alias"));
    await assert.rejects(f.browser.tree(f.issue, "application", "control-alias"), /invalid_source_path/);
    await assert.rejects(f.browser.file(f.issue, "application", "config-alias"), /invalid_source_path/);
    await assert.rejects(f.browser.createFile(f.issue, "application", "control-alias/new.txt", "forbidden"), /invalid_source_path|source_path_outside_repository/);
    await f.browser.deletePath(f.issue, "application", "control-alias", false);
    assert.ok((await lstat(path.join(f.repository, ".git"))).isDirectory());
  } finally { await f.close(); }
});

test("treats bracket characters in source paths literally when staging and discarding", async () => {
  const f = await fixture();
  try {
    for (const name of ["value[1].txt", "value1.txt"]) await writeFile(path.join(f.repository, name), "original\n");
    await f.git(["add", "."]);
    await f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial"]);
    for (const name of ["value[1].txt", "value1.txt"]) await writeFile(path.join(f.repository, name), "changed\n");
    await f.browser.stage(f.issue, "application", ["value[1].txt"]);
    assert.equal(await f.git(["diff", "--cached", "--name-only"]), "value[1].txt");
    await f.browser.unstage(f.issue, "application", ["value[1].txt"]);
    await f.browser.discard(f.issue, "application", ["value[1].txt"]);
    assert.equal(await readFile(path.join(f.repository, "value[1].txt"), "utf8"), "original\n");
    assert.equal(await readFile(path.join(f.repository, "value1.txt"), "utf8"), "changed\n");
  } finally { await f.close(); }
});

test("rejects a directory as a source blame file", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.repository, "folder"));
    await assert.rejects(f.browser.blame(f.issue, "application", "folder", 1), /source_path_not_file/);
  } finally { await f.close(); }
});

test("rejects a FIFO blame target without opening or waiting for it", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    const fifo = path.join(f.repository, "pipe.txt");
    const created = await executeLocalCommand("mkfifo", [fifo]);
    assert.equal(created.code, 0, created.stderr);
    const script = `
      import { SourceBrowser } from ${JSON.stringify(new URL("../../src/workspace/source-browser.ts", import.meta.url).href)};
      import { openDatabase } from ${JSON.stringify(new URL("../../src/db/client.ts", import.meta.url).href)};
      const database = openDatabase(process.argv[1]);
      try {
        await new SourceBrowser(database.db, process.argv[2]).blame({ id: process.argv[3], key: process.argv[4] }, "application", "pipe.txt", 1);
        console.log("unexpected_success");
      } catch (error) { console.log(error.message); }
      finally { await database.close(); }
    `;
    // A separate process makes a regression's blocking FIFO read safe to terminate.
    const result = await executeLocalCommand(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, path.join(f.root, "issues.db"), f.root, f.issue.id, f.issue.key], { timeout: 2_000 });
    assert.equal(result.killed, false, "blame must reject nonregular files without blocking");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "source_path_not_file");
  } finally { await f.close(); }
});

test("reads history and commit changes for files deleted from the working tree", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repository, "deleted.txt"), "historical contents\n");
    await f.git(["add", "deleted.txt"]);
    await f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Add historical file"]);
    await rm(path.join(f.repository, "deleted.txt"));
    await f.git(["add", "-A"]);
    await f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Delete historical file"]);
    const head = await f.git(["rev-parse", "HEAD"]);
    const history = await f.browser.history(f.issue, "application", "deleted.txt");
    assert.deepEqual(history.commits.map(commit => commit.subject), ["Delete historical file", "Add historical file"]);
    assert.deepEqual(await f.browser.commit(f.issue, "application", head, "deleted.txt"), { files: [{ path: "deleted.txt", status: "deleted", previousPath: null }], truncated: false });
    const compared = await f.browser.commitFile(f.issue, "application", head, "deleted.txt");
    assert.equal(compared.before?.content, "historical contents\n");
    assert.equal(compared.after, null);
    await assert.rejects(f.browser.history(f.issue, "application", ".git/config"), /invalid_source_path/);
  } finally { await f.close(); }
});

test("labels staged and unstaged comparisons with their actual Git versions", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repository, "versions.txt"), "head contents\n");
    await f.git(["add", "versions.txt"]);
    await f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Initial version"]);
    await writeFile(path.join(f.repository, "versions.txt"), "index contents\n");
    await f.git(["add", "versions.txt"]);
    await writeFile(path.join(f.repository, "versions.txt"), "working contents\n");
    const staged = await f.browser.diffFile(f.issue, "application", "versions.txt", true);
    assert.deepEqual(staged.before, { path: "versions.txt", version: "head", content: "head contents\n" });
    assert.deepEqual(staged.after, { path: "versions.txt", version: "index", content: "index contents\n" });
    const working = await f.browser.diffFile(f.issue, "application", "versions.txt");
    assert.deepEqual(working.before, { path: "versions.txt", version: "index", content: "index contents\n" });
    assert.deepEqual(working.after, { path: "versions.txt", version: "working-tree", content: "working contents\n" });
  } finally { await f.close(); }
});

test("reads literal Unicode replacement characters from Git and rejects malformed text bytes", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.repository, "unicode.txt");
    await writeFile(file, "before � text\n");
    await f.git(["add", "unicode.txt"]);
    await f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Unicode text"]);
    await writeFile(file, "after � text\n");
    await f.git(["add", "unicode.txt"]);
    assert.equal((await f.browser.file(f.issue, "application", "unicode.txt")).content, "after � text\n");
    const compared = await f.browser.diffFile(f.issue, "application", "unicode.txt", true);
    assert.equal(compared.before?.content, "before � text\n");
    assert.equal(compared.after?.content, "after � text\n");
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe4, 0xb8]), Buffer.from([0])]) {
      await writeFile(file, bytes);
      await f.git(["add", "unicode.txt"]);
      await assert.rejects(f.browser.diffFile(f.issue, "application", "unicode.txt", true), /source_file_binary/);
    }
  } finally { await f.close(); }
});

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
