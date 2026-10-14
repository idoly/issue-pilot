import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { eq } from "drizzle-orm";

import type { CommandExecutor } from "../../src/process.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issueRepositories, issues, issueWorkspaces, serviceDeployments, services, subjects } from "../../src/db/schema.ts";
import { prepareIssueRuntime } from "../../src/workspace/runtime.ts";
import { SourceBrowser } from "../../src/workspace/source-browser.ts";
import { issueWorkspaceRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

test("browses only registered Issue repository content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-source-browser-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "dev")).limit(1);
    assert.ok(environment);
    await database.db.insert(subjects).values({ subject: "source-tester" });
    const [service] = await database.db.insert(services).values({ key: "source-browser", name: "Source Browser" }).returning();
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment.id, config: {} });
    const [issue] = await database.db.insert(issues).values({
      key: "ISSUE-20260815-002", title: "Browse source", type: "defect_fix", serviceId: service!.id, environmentId: environment.id, reporterSubject: "source-tester",
    }).returning();
    const repository = path.join(issueWorkspaceRoot(root, issue!.key), "application");
    await mkdir(path.join(repository, "src"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(repository, ".git"), { mode: 0o700 });
    await writeFile(path.join(repository, "README.md"), "# Application\n", "utf8");
    await writeFile(path.join(repository, "src", "index.ts"), "export const ready = true;\n", "utf8");
    await database.db.insert(issueRepositories).values({
      issueId: issue!.id, url: "https://git.example.test/application.git", baseBranch: "main", workingBranch: "hotfix-issue-20260815-002",
      localPath: repository, workspaceName: "application", commitBefore: "a".repeat(40),
    });
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", runtimeReady: true });
    await prepareIssueRuntime(root, issue!.key, [{ name: "application", repositoryPath: repository }], "write");

    const commands: Array<{ command: string; args: string[]; cwd?: string; maxOutputBytes?: number | null }> = [];
    const executor: CommandExecutor = {
      async execute(command, args, options) {
        commands.push({ command, args, ...(options?.cwd ? { cwd: options.cwd } : {}), ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}) });
        if (command === "rg") return {
          code: 0, stderr: "", killed: false,
          stdout: `${JSON.stringify({ type: "match", data: { path: { text: "./src/index.ts" }, lines: { text: "export const ready = true;\n" }, line_number: 1, submatches: [{ start: 13 }] } })}\n`,
        };
        if (args.includes("log")) return { code: 0, stderr: "", killed: false, stdout: `${"b".repeat(40)}\x1f${"a".repeat(40)}\x1fTest User\x1f2026-08-15T08:00:00+08:00\x1fFix source browser\x1e\n` };
        if (args.includes("blame")) return { code: 0, stderr: "", killed: false, stdout: `${"b".repeat(40)} 1 1 1\nauthor Test User\nauthor-mail <test@example.test>\nauthor-time 1786752000\nauthor-tz +0800\nsummary Fix source browser\nfilename src/index.ts\n\texport const ready = true;\n` };
        if (args.includes("merge-base")) return { code: args.includes("c".repeat(40)) ? 1 : 0, stderr: "", killed: false, stdout: "" };
        if (args.includes("rev-list")) return { code: 0, stderr: "", killed: false, stdout: `${"b".repeat(40)} ${"a".repeat(40)}\n` };
        if (args.includes("--name-status")) return { code: 0, stderr: "", killed: false, stdout: "M\0src/index.ts\0R100\0README.md\0GUIDE.md\0" };
        if (args.includes("cat-file") && args.includes("-s")) return { code: 0, stderr: "", killed: false, stdout: "28\n" };
        if (args.includes("cat-file") && args.includes("blob")) return { code: 0, stderr: "", killed: false, stdout: /^(a|:)/.test(args.at(-1)!) ? "export const ready = false;\n" : "export const ready = true;\n" };
        if (args.includes("ls-files") && !args.includes("--others")) return { code: 0, stderr: "", killed: false, stdout: "src/index.ts\0" };
        return { code: 0, stderr: "", killed: false, stdout: "" };
      },
    };
    const browser = new SourceBrowser(database.db, root, executor);
    assert.deepEqual(await browser.repositories(issue!), [{ name: "application", url: "https://git.example.test/application.git", branch: "hotfix-issue-20260815-002", access: "write" }]);
    const tree = await browser.tree(issue!, "application");
    assert.deepEqual(tree.entries.map(({ name, type }) => ({ name, type })), [{ name: "src", type: "directory" }, { name: "README.md", type: "file" }]);
    const sourceFile = await browser.file(issue!, "application", "src/index.ts");
    assert.equal(sourceFile.content, "export const ready = true;\n");
    assert.match(sourceFile.sha256, /^[a-f0-9]{64}$/);
    const savedFile = await browser.writeFile(issue!, "application", "src/index.ts", "export const ready = false;\n", sourceFile.sha256);
    assert.equal(savedFile.content, "export const ready = false;\n");
    assert.equal(await readFile(path.join(repository, "src", "index.ts"), "utf8"), "export const ready = false;\n");
    await assert.rejects(browser.writeFile(issue!, "application", "src/index.ts", "stale\n", sourceFile.sha256), /source_file_changed/);
    await assert.rejects(browser.writeFile(issue!, "application", "src/missing.ts", "new\n", savedFile.sha256), /source_path_not_found/);
    await browser.writeFile(issue!, "application", "src/index.ts", "export const ready = true;\n", savedFile.sha256);
    await browser.createDirectory(issue!, "application", "generated");
    await browser.createFile(issue!, "application", "generated/value.ts", "export const value = 1;\n");
    await browser.renamePath(issue!, "application", "generated/value.ts", "generated/result.ts", false);
    assert.equal(await readFile(path.join(repository, "generated", "result.ts"), "utf8"), "export const value = 1;\n");
    const largeSource = "x".repeat(2 * 1024 * 1024 + 1);
    const largeFile = await browser.createFile(issue!, "application", "generated/large.txt", largeSource);
    assert.equal(largeFile.size, Buffer.byteLength(largeSource));
    assert.equal((await browser.file(issue!, "application", "generated/large.txt")).content.length, largeSource.length);
    await browser.deletePath(issue!, "application", "generated", true);
    await assert.rejects(readFile(path.join(repository, "generated", "result.ts")), /ENOENT/);
    await browser.stage(issue!, "application", ["src/index.ts"]);
    await browser.unstage(issue!, "application", ["src/index.ts"]);
    await browser.discard(issue!, "application", ["src/index.ts"]);
    await browser.createCommit(issue!, "application", "Update source browser", { name: "Test User", email: "test@example.test" });
    assert.deepEqual(await browser.search(issue!, "application", "ready"), {
      matches: [{ path: "src/index.ts", line: 1, column: 14, preview: "export const ready = true;" }], truncated: false,
    });
    await browser.search(issue!, "application", "ready", { caseSensitive: false, wordMatch: true });
    const completeSearchBrowser = new SourceBrowser(database.db, root, {
      async execute(_command, _args, options) {
        assert.equal(options?.maxOutputBytes, null);
        const matches = Array.from({ length: 250 }, (_, index) => JSON.stringify({ type: "match", data: { path: { text: `./src/result-${index}.ts` }, lines: { text: "export const ready = true;\n" }, line_number: index + 1, submatches: [{ start: 13 }] } }));
        return { code: 0, stderr: "", killed: false, stdout: `${matches.join("\n")}\n` };
      },
    });
    const completeSearch = await completeSearchBrowser.search(issue!, "application", "ready");
    assert.equal(completeSearch.matches.length, 250);
    assert.deepEqual(completeSearch.matches.at(-1), { path: "src/result-249.ts", line: 250, column: 14, preview: "export const ready = true;" });
    assert.equal(completeSearch.truncated, false);
    assert.deepEqual(await browser.blame(issue!, "application", "src/index.ts", 1), {
      path: "src/index.ts", line: 1, commit: "b".repeat(40), shortCommit: "b".repeat(8), author: "Test User", date: "2026-08-15T00:00:00.000Z", subject: "Fix source browser",
    });
    assert.deepEqual(await browser.history(issue!, "application"), {
      commits: [{ hash: "b".repeat(40), shortHash: "b".repeat(8), parents: ["a".repeat(40)], author: "Test User", date: "2026-08-15T08:00:00+08:00", subject: "Fix source browser" }],
      truncated: false,
    });
    assert.deepEqual(await browser.commit(issue!, "application", "b".repeat(40)), {
      files: [
        { status: "modified", path: "src/index.ts", previousPath: null },
        { status: "renamed", path: "GUIDE.md", previousPath: "README.md" },
      ],
      truncated: false,
    });
    assert.deepEqual(await browser.commitFile(issue!, "application", "b".repeat(40), "src/index.ts"), {
      file: { status: "modified", path: "src/index.ts", previousPath: null },
      before: { path: "src/index.ts", revision: "a".repeat(40), content: "export const ready = false;\n" },
      after: { path: "src/index.ts", revision: "b".repeat(40), content: "export const ready = true;\n" },
    });
    assert.deepEqual(await browser.diff(issue!, "application"), {
      files: [
        { status: "modified", path: "src/index.ts", previousPath: null },
        { status: "renamed", path: "GUIDE.md", previousPath: "README.md" },
      ],
      truncated: false,
    });
    assert.deepEqual(await browser.diffFile(issue!, "application", "src/index.ts"), {
      file: { status: "modified", path: "src/index.ts", previousPath: null },
      before: { path: "src/index.ts", version: "index", content: "export const ready = false;\n" },
      after: { path: "src/index.ts", version: "working-tree", content: "export const ready = true;\n" },
    });
    const searchCommands = commands.filter(({ command }) => command === "rg");
    assert.equal(searchCommands[0]!.cwd, repository);
    assert.ok(searchCommands[0]!.args.includes("--json"));
    assert.ok(searchCommands[0]!.args.includes("--fixed-strings"));
    assert.ok(searchCommands[0]!.args.includes("--max-columns-preview"));
    assert.ok(!searchCommands[0]!.args.includes("--max-filesize"));
    assert.equal(searchCommands[0]!.args[searchCommands[0]!.args.indexOf("--max-columns") + 1], "1000");
    assert.ok(!searchCommands[0]!.args.includes("--ignore-case"));
    assert.ok(searchCommands[1]!.args.includes("--ignore-case"));
    assert.ok(searchCommands[1]!.args.includes("--word-regexp"));
    const blameCommand = commands.find(({ args }) => args.includes("blame"))!;
    assert.deepEqual(blameCommand.args.slice(-4), ["-L", "1,1", "--", "src/index.ts"]);
    const historyCommand = commands.find(({ args }) => args.includes("log"))!;
    assert.match(historyCommand.args.find((argument) => argument.startsWith("--format="))!, /%H%x1f%P/);
    const commitDiffCommand = commands.find(({ args }) => args.includes("--name-status"))!;
    assert.ok(commitDiffCommand.args.includes("--no-ext-diff"));
    assert.ok(commitDiffCommand.args.includes("--no-textconv"));
    assert.ok(commands.some(({ args, maxOutputBytes }) => args.includes("cat-file") && args.includes("blob") && maxOutputBytes === null));
    const workspaceDiffCommand = commands.find(({ args }) => args.includes("diff") && args.includes("--name-status") && !args.includes("a".repeat(40)))!;
    assert.ok(workspaceDiffCommand.args.includes("--no-ext-diff"));
    assert.ok(workspaceDiffCommand.args.includes("--no-textconv"));
    assert.ok(commands.some(({ args }) => args.at(-1) === ":src/index.ts"));
    assert.ok(commands.some(({ args }) => args.includes("add") && args.includes("src/index.ts")));
    assert.ok(commands.some(({ args }) => args.includes("reset") && args.includes("HEAD")));
    assert.ok(commands.some(({ args }) => args.includes("checkout") && args.includes("src/index.ts")));
    assert.ok(commands.some(({ args }) => args.includes("clean") && args.includes("-fd")));
    assert.ok(commands.some(({ args }) => args.includes("commit") && args.includes("Update source browser")));

    await assert.rejects(browser.file(issue!, "application", "../outside.txt"), /invalid_source_path/);
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "secret\n", "utf8");
    await symlink(outside, path.join(repository, "outside-link"));
    await assert.rejects(browser.file(issue!, "application", "outside-link"), /source_path_outside_repository/);
    await assert.rejects(browser.tree(issue!, "unknown"), /source_repository_not_found/);
    await assert.rejects(browser.commit(issue!, "application", "c".repeat(40)), /source_commit_not_found/);

    const [readOnlyIssue] = await database.db.insert(issues).values({
      key: "ISSUE-20260815-003", title: "Read source", type: "defect_fix", serviceId: service!.id, environmentId: environment.id, reporterSubject: "source-tester",
    }).returning();
    const readOnlyRepository = path.join(sharedCheckoutsRoot(root), "b".repeat(20), "c".repeat(40));
    await mkdir(path.join(readOnlyRepository, ".git"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(readOnlyRepository, "README.md"), "# Snapshot\n", "utf8");
    await database.db.insert(issueRepositories).values({
      issueId: readOnlyIssue!.id, url: "https://git.example.test/application.git", baseBranch: "main", commitBefore: "c".repeat(40), workspaceName: "application",
    });
    await database.db.insert(issueWorkspaces).values({ issueId: readOnlyIssue!.id, status: "ready", runtimeReady: true });
    await prepareIssueRuntime(root, readOnlyIssue!.key, [{ name: "application", repositoryPath: readOnlyRepository }], "read");
    const snapshot = await browser.file(readOnlyIssue!, "application", "README.md");
    await assert.rejects(browser.writeFile(readOnlyIssue!, "application", "README.md", "changed\n", snapshot.sha256), /source_read_only/);
    await assert.rejects(browser.createFile(readOnlyIssue!, "application", "new.txt", "new\n"), /source_read_only/);
    await assert.rejects(browser.stage(readOnlyIssue!, "application", ["README.md"]), /source_read_only/);
    await assert.rejects(browser.createCommit(readOnlyIssue!, "application", "Not allowed", { name: "Test User", email: "test@example.test" }), /source_read_only/);

    await database.db.update(issueWorkspaces).set({ runtimeReady: false }).where(eq(issueWorkspaces.issueId, issue!.id));
    await assert.rejects(browser.repositories(issue!), /source_browser_unavailable/);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
