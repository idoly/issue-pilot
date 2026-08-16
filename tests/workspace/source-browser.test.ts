import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { eq } from "drizzle-orm";

import type { CommandExecutor } from "../../src/capabilities/local-exec.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issueRepositories, issues, issueWorkspaces, serviceDeployments, services, subjects } from "../../src/db/schema.ts";
import { prepareIssueRuntime } from "../../src/workspace/runtime.ts";
import { SourceBrowser } from "../../src/workspace/source-browser.ts";
import { issueWorkspaceRoot } from "../../src/workspace/state.ts";

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

    const commands: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const executor: CommandExecutor = {
      async execute(command, args, options) {
        commands.push({ command, args, ...(options?.cwd ? { cwd: options.cwd } : {}) });
        if (command === "rg") return {
          code: 0, stderr: "", killed: false,
          stdout: `${JSON.stringify({ type: "match", data: { path: { text: "./src/index.ts" }, lines: { text: "export const ready = true;\n" }, line_number: 1, submatches: [{ start: 13 }] } })}\n`,
        };
        if (args.includes("log")) return { code: 0, stderr: "", killed: false, stdout: `${"b".repeat(40)}\x1f${"a".repeat(40)}\x1fTest User\x1f2026-08-15T08:00:00+08:00\x1fFix source browser\x1e\n` };
        if (args.includes("merge-base")) return { code: args.includes("c".repeat(40)) ? 1 : 0, stderr: "", killed: false, stdout: "" };
        if (args.includes("rev-list")) return { code: 0, stderr: "", killed: false, stdout: `${"b".repeat(40)} ${"a".repeat(40)}\n` };
        if (args.includes("--name-status")) return { code: 0, stderr: "", killed: false, stdout: "M\0src/index.ts\0R100\0README.md\0GUIDE.md\0" };
        if (args.includes("cat-file") && args.includes("-s")) return { code: 0, stderr: "", killed: false, stdout: "28\n" };
        if (args.includes("cat-file") && args.includes("blob")) return { code: 0, stderr: "", killed: false, stdout: /^(a|:)/.test(args.at(-1)!) ? "export const ready = false;\n" : "export const ready = true;\n" };
        return { code: 0, stderr: "", killed: false, stdout: "" };
      },
    };
    const browser = new SourceBrowser(database.db, root, executor);
    assert.deepEqual(await browser.repositories(issue!), [{ name: "application", url: "https://git.example.test/application.git", branch: "hotfix-issue-20260815-002", access: "write" }]);
    const tree = await browser.tree(issue!, "application");
    assert.deepEqual(tree.entries.map(({ name, type }) => ({ name, type })), [{ name: "src", type: "directory" }, { name: "README.md", type: "file" }]);
    assert.equal((await browser.file(issue!, "application", "src/index.ts")).content, "export const ready = true;\n");
    assert.deepEqual(await browser.search(issue!, "application", "ready"), {
      matches: [{ path: "src/index.ts", line: 1, column: 14, preview: "export const ready = true;" }], truncated: false,
    });
    await browser.search(issue!, "application", "ready", { caseSensitive: false, wordMatch: true });
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
    assert.ok(!searchCommands[0]!.args.includes("--ignore-case"));
    assert.ok(searchCommands[1]!.args.includes("--ignore-case"));
    assert.ok(searchCommands[1]!.args.includes("--word-regexp"));
    const historyCommand = commands.find(({ args }) => args.includes("log"))!;
    assert.match(historyCommand.args.find((argument) => argument.startsWith("--format="))!, /%H%x1f%P/);
    const commitDiffCommand = commands.find(({ args }) => args.includes("--name-status"))!;
    assert.ok(commitDiffCommand.args.includes("--no-ext-diff"));
    assert.ok(commitDiffCommand.args.includes("--no-textconv"));
    assert.ok(commands.some(({ args }) => args.includes("cat-file") && args.includes("blob")));
    const workspaceDiffCommand = commands.find(({ args }) => args.includes("diff") && args.includes("--name-status") && !args.includes("a".repeat(40)))!;
    assert.ok(workspaceDiffCommand.args.includes("--no-ext-diff"));
    assert.ok(workspaceDiffCommand.args.includes("--no-textconv"));
    assert.ok(commands.some(({ args }) => args.at(-1) === ":src/index.ts"));

    await assert.rejects(browser.file(issue!, "application", "../outside.txt"), /invalid_source_path/);
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "secret\n", "utf8");
    await symlink(outside, path.join(repository, "outside-link"));
    await assert.rejects(browser.file(issue!, "application", "outside-link"), /source_path_outside_repository/);
    await assert.rejects(browser.tree(issue!, "unknown"), /source_repository_not_found/);
    await assert.rejects(browser.commit(issue!, "application", "c".repeat(40)), /source_commit_not_found/);
    await database.db.update(issueWorkspaces).set({ runtimeReady: false }).where(eq(issueWorkspaces.issueId, issue!.id));
    await assert.rejects(browser.repositories(issue!), /source_browser_unavailable/);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
