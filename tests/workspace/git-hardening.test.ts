import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issueRepositories, issues, issueWorkspaces, serviceDeployments, services } from "../../src/db/schema.ts";
import { createWorkspaceTool } from "../../src/agent/workspace-tool.ts";
import { gitIdentityEnvironment } from "../../src/agent/pi-session.ts";
import { executeLocalCommand, type CommandExecutor } from "../../src/process.ts";
import { OperationError } from "../../src/operation-error.ts";
import { errorChain, errorDiagnostic } from "../../src/diagnostics.ts";
import { assertNoEmbeddedRepository, trustedGitArgs } from "../../src/workspace/git-command.ts";
import { IssueProjectManager } from "../../src/workspace/project.ts";
import { SourceBrowser } from "../../src/workspace/source-browser.ts";
import { claimIssueRoot } from "../../src/workspace/state.ts";
import { WorktreeManager } from "../../src/workspace/git.ts";
import { git } from "../helpers/git.ts";

/**
 * A nested repository's core.fsmonitor is a command. Trusted application Git runs outside the
 * sandbox and must never execute it, even when the nested repository is recorded as a gitlink.
 */
async function nestedRepository(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await git(["init", directory]);
  await writeFile(path.join(directory, "inside.txt"), "nested\n", "utf8");
  await git(["-C", directory, "add", "."]);
  await git(["-C", directory, "commit", "-m", "nested"]);
}

async function hostileNestedRepository(directory: string, marker: string): Promise<void> {
  await nestedRepository(directory);
  await git(["-C", directory, "config", "core.fsmonitor", `touch ${marker}`]);
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-git-hardening-"));
  const state = path.join(root, "state"),
    source = path.join(root, "source"),
    marker = path.join(root, "fsmonitor-executed");
  const issueKey = "ISSUE-20261117-901";
  // A committed gitlink stands in for an upstream submodule: it stays usable, but is never recursed into.
  await nestedRepository(path.join(source, "upstream-module"));
  await git(["init", "-b", "main", source]);
  await writeFile(path.join(source, "README.md"), "baseline\n", "utf8");
  await writeFile(path.join(source, "file.txt"), "first\nsecond\n", "utf8");
  await git(["-C", source, "add", "README.md", "file.txt", "upstream-module"]);
  await git(["-C", source, "commit", "-m", "initial"]);
  await claimIssueRoot(state, issueKey);
  const prepared = await new WorktreeManager(state).prepare({ issueKey, workspaceName: "repo", url: source, baseBranch: "main", mode: "hotfix" });
  const database = await openApplicationDatabase(path.join(state, "issues.db"));
  const [environment] = await database.db.select().from(environments).where(eq(environments.key, "dev"));
  const [service] = await database.db.insert(services).values({ key: "git-hardening", name: "Git hardening" }).returning();
  await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
  const [issue] = await database.db
    .insert(issues)
    .values({ key: issueKey, title: "Git hardening", type: "defect_fix", serviceId: service!.id, environmentId: environment!.id, reporterSubject: issuePilotConfig.bootstrapUser.subject })
    .returning();
  await database.db.insert(issueRepositories).values({
    issueId: issue!.id,
    url: source,
    baseBranch: "main",
    workingBranch: prepared.workingBranch,
    localPath: prepared.workspacePath,
    workspaceName: "repo",
    commitBefore: prepared.baseCommit,
  });
  await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", runtimeReady: true });
  return {
    root,
    source,
    marker,
    prepared,
    issue: issue!,
    database,
    workspacePath: prepared.workspacePath,
    manager: new WorktreeManager(state),
    browser: new SourceBrowser(database.db, state),
    tool: await createWorkspaceTool(database.db, issue!, "dev", new IssueProjectManager(database.db, state), {
      stateRoot: state,
      runtimeRoot: path.dirname(prepared.workspacePath),
      commitEnvironment: gitIdentityEnvironment({ name: "Fixture", email: "fixture@example.test" }),
      networkDomains: [],
    }),
    close: async () => {
      await database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function markerExists(file: string): Promise<boolean> {
  return readFile(file, "utf8").then(
    () => true,
    () => false,
  );
}

test("repository-controlled fsmonitor never runs during trusted Git inspection", async () => {
  const f = await fixture();
  try {
    // Hostile case 1: a new embedded repository staged as a gitlink in the model-writable worktree.
    await hostileNestedRepository(path.join(f.workspacePath, "embedded"), f.marker);
    await git(["-C", f.workspacePath, "add", "-A"]);
    assert.equal((await git(["-C", f.workspacePath, "ls-files", "-s", "--", "embedded"])).slice(0, 6), "160000");

    // Establish that the fixture reproduces the vulnerability without the hardening.
    await git(["-C", f.workspacePath, "status", "--porcelain=v2"]);
    assert.equal(await markerExists(f.marker), true, "the fixture must exercise a nested fsmonitor");
    await rm(f.marker, { force: true });

    // The shared helper protects even a status invocation without the explicit submodule flag.
    assert.equal((await executeLocalCommand("git", trustedGitArgs(["-C", f.workspacePath, "status", "--porcelain=v2"]))).code, 0);
    assert.equal(await markerExists(f.marker), false, "the shared Git helper must disable repository fsmonitor");

    // Hostile case 2: the worktree path of an upstream gitlink is recreated as a nested repository.
    await hostileNestedRepository(path.join(f.workspacePath, "upstream-module"), f.marker);
    await git(["-C", f.workspacePath, "status", "--porcelain=v2"]);
    assert.equal(await markerExists(f.marker), true, "a recorded gitlink must also reproduce the vulnerability");
    await rm(f.marker, { force: true });

    const issue = { id: f.issue.id, key: f.issue.key };
    await writeFile(path.join(f.workspacePath, "README.md"), "changed\n", "utf8");
    await git(["-C", f.workspacePath, "add", "--", "README.md"]);
    assert.deepEqual(await f.browser.repositories(issue), [{ name: "repo", url: f.source, branch: f.prepared.workingBranch, access: "write" }]);
    assert.ok((await f.browser.tree(issue, "repo")).entries.some(({ name }) => name === "README.md"));
    assert.equal((await f.browser.file(issue, "repo", "README.md")).content, "changed\n");
    assert.notEqual((await f.browser.blame(issue, "repo", "file.txt", 2)).commit, null);
    assert.ok((await f.browser.history(issue, "repo")).commits.length >= 1);
    await f.browser.diff(issue, "repo");
    assert.ok((await f.browser.diff(issue, "repo", "", true)).files.some(({ path: file }) => file === "README.md"));
    assert.equal((await f.browser.diffFile(issue, "repo", "README.md", true)).file.path, "README.md");
    await f.browser.commit(issue, "repo", f.prepared.baseCommit);
    assert.equal(await markerExists(f.marker), false, "source browser Git must not run a nested fsmonitor");

    // The staged embedded repository blocks staging and committing, and is removed from the index.
    await assert.rejects(f.browser.stage(issue, "repo", ["README.md"]), { message: "embedded_repository_not_allowed" });
    assert.equal(await git(["-C", f.workspacePath, "ls-files", "--", "embedded"]), "");
    await f.browser.stage(issue, "repo", ["README.md"]);
    assert.equal(await git(["-C", f.workspacePath, "ls-files", "--", "README.md"]), "README.md");
    await git(["-C", f.workspacePath, "add", "-A", "--", "embedded"]);
    await assert.rejects(f.browser.createCommit(issue, "repo", "embedded", { name: "Test", email: "test@example.test" }), { message: "embedded_repository_not_allowed" });
    assert.equal(await git(["-C", f.workspacePath, "ls-files", "--", "embedded"]), "");
    await git(["-C", f.workspacePath, "reset", "-q"]);
    await writeFile(path.join(f.workspacePath, "README.md"), "baseline\n", "utf8");
    assert.equal(await markerExists(f.marker), false, "stage/commit guards must not run a nested fsmonitor");

    // Release inspection refuses the staged gitlink without inspecting the nested repository.
    await git(["-C", f.workspacePath, "add", "--", "embedded"]);
    await assert.rejects(f.manager.remove(f.source, f.workspacePath, f.prepared.workingBranch!), { message: "workspace_has_changes" });
    assert.equal(await markerExists(f.marker), false, "release inspection must not run a nested fsmonitor");
    await git(["-C", f.workspacePath, "reset", "-q"]);

    // The workspace tool refuses the same embedded repository through its sandboxed Git as well.
    const update = (input: Record<string, unknown>) => f.tool.execute("fixture", { repository: "repo", ...input } as never, undefined, undefined, {} as never);
    await assert.rejects(update({ operation: "stage", paths: ["embedded"] }), { message: "embedded_repository_not_allowed" });
    assert.equal(await git(["-C", f.workspacePath, "ls-files", "--", "embedded"]), "");
    await git(["-C", f.workspacePath, "add", "-A", "--", "embedded"]);
    await assert.rejects(update({ operation: "commit", message: "embedded" }), { message: "embedded_repository_not_allowed" });
    assert.equal(await git(["-C", f.workspacePath, "ls-files", "--", "embedded"]), "");
    assert.equal(await markerExists(f.marker), false, "workspace tool Git must not run a nested fsmonitor");

    // A recorded upstream gitlink remains stageable and is never recursed into.
    await update({ operation: "stage", paths: ["upstream-module"] });
    assert.equal((await git(["-C", f.workspacePath, "ls-files", "-s", "--", "upstream-module"])).slice(0, 6), "160000");
    // A staged update to the recorded gitlink is still a local change and blocks release.
    await assert.rejects(f.manager.remove(f.source, f.workspacePath, f.prepared.workingBranch!), { message: "workspace_has_changes" });
    assert.equal(await markerExists(f.marker), false, "recorded gitlinks must not be recursed into");

    // Shared snapshot inspection is hardened the same way.
    const shared = await f.manager.prepareShared({ url: f.source, baseBranch: "main" });
    await hostileNestedRepository(path.join(shared.workspacePath, "embedded"), f.marker);
    await assert.rejects(f.manager.assertSharedCheckout(shared.workspacePath, shared.baseCommit, shared.cachePath), { message: "shared_checkout_changed" });
    assert.equal(await markerExists(f.marker), false, "shared checkout inspection must not run a nested fsmonitor");
  } finally {
    await f.close();
  }
});

for (const entry of ["source", "agent"] as const) {
  test(`${entry} commit reports failed gitlink cleanup and retains the index for a safe retry`, async () => {
    const f = await fixture();
    try {
      await nestedRepository(path.join(f.workspacePath, "embedded"));
      await writeFile(path.join(f.workspacePath, "README.md"), "staged work\n");
      await git(["-C", f.workspacePath, "add", "--", "README.md", "embedded"]);
      const index = path.resolve(f.workspacePath, await git(["-C", f.workspacePath, "rev-parse", "--git-path", "index"]));
      const before = await readFile(index);
      await writeFile(`${index}.lock`, "another writer owns this lock");
      const commit = () =>
        entry === "source"
          ? f.browser.createCommit(f.issue, "repo", "valid work", { name: "Test", email: "test@example.test" })
          : f.tool.execute("fixture", { operation: "commit", repository: "repo", message: "valid work" } as never, undefined, undefined, {} as never);
      await assert.rejects(commit(), (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.message, "workspace_git_index_cleanup_failed");
        assert.equal(error.outcome, "unknown");
        assert.equal((errorDiagnostic(error) as Error).message, "workspace_git_index_cleanup_failed");
        const failures = errorChain(error);
        assert.ok(failures.some((cause) => cause instanceof Error && cause.message === "embedded_repository_not_allowed"));
        assert.ok(failures.some((cause) => cause && typeof cause === "object" && "stderr" in cause && typeof cause.stderr === "string" && cause.stderr.includes("index.lock")));
        return true;
      });
      assert.deepEqual(await readFile(index), before);
      assert.equal(await readFile(`${index}.lock`, "utf8"), "another writer owns this lock");
      assert.equal(await git(["-C", f.workspacePath, "rev-parse", "HEAD"]), f.prepared.baseCommit);
      await rm(`${index}.lock`);
      await assert.rejects(commit(), { message: "embedded_repository_not_allowed" });
      assert.equal(await git(["-C", f.workspacePath, "ls-files", "--", "embedded"]), "");
      assert.equal(await git(["-C", f.workspacePath, "show", ":README.md"]), "staged work");
      await commit();
      assert.equal(await git(["-C", f.workspacePath, "show", "HEAD:README.md"]), "staged work");
    } finally {
      await f.close();
    }
  });
}

for (const embedded of [":(glob)*", "嵌套仓库", "replacement-�"]) {
  test(`embedded repository cleanup preserves the literal name ${embedded} and unrelated staged work`, async () => {
    const f = await fixture();
    try {
      await nestedRepository(path.join(f.workspacePath, embedded));
      await writeFile(path.join(f.workspacePath, "README.md"), "staged work\n");
      await git(["--literal-pathspecs", "-C", f.workspacePath, "add", "--", "README.md", embedded]);
      await assert.rejects(f.tool.execute("fixture", { operation: "commit", repository: "repo", message: "rejected" } as never, undefined, undefined, {} as never), {
        message: "embedded_repository_not_allowed",
      });
      assert.equal(await git(["--literal-pathspecs", "-C", f.workspacePath, "ls-files", "--", embedded]), "");
      assert.equal(await git(["-C", f.workspacePath, "show", ":README.md"]), "staged work");
      assert.equal(await git(["-C", f.workspacePath, "rev-parse", "HEAD"]), f.prepared.baseCommit);
    } finally {
      await f.close();
    }
  });
}

test("invalid UTF-8 Git paths cannot unstage a different file with the decoded replacement name", async () => {
  const f = await fixture();
  try {
    const nested = path.join(f.root, "invalid-name-repository");
    await nestedRepository(nested);
    const malformedPath = Buffer.concat([Buffer.from(`${f.workspacePath}/invalid-`), Buffer.from([0xff])]);
    await rename(nested, malformedPath);
    const lookalike = "invalid-�";
    await writeFile(path.join(f.workspacePath, lookalike), "staged work\n");
    await git(["-C", f.workspacePath, "add", "-A"]);
    const index = path.resolve(f.workspacePath, await git(["-C", f.workspacePath, "rev-parse", "--git-path", "index"]));
    const before = await readFile(index);
    await assert.rejects(f.browser.createCommit(f.issue, "repo", "rejected", { name: "Test", email: "test@example.test" }), { message: "workspace_git_index_invalid" });
    assert.deepEqual(await readFile(index), before);
    assert.equal(await git(["-C", f.workspacePath, "show", `:${lookalike}`]), "staged work");
    assert.equal(await git(["-C", f.workspacePath, "rev-parse", "HEAD"]), f.prepared.baseCommit);
  } finally {
    await f.close();
  }
});

for (const failure of ["timeout", "spawn"] as const) {
  test(`gitlink cleanup preserves ${failure} failures instead of claiming the index was restored`, async () => {
    const f = await fixture();
    try {
      await nestedRepository(path.join(f.workspacePath, "embedded"));
      await git(["-C", f.workspacePath, "add", "--", "embedded"]);
      const spawnFailure = new Error("fixture_git_spawn_failed");
      const terminated = { stdout: "", stderr: "", code: 0, killed: true };
      const executor: CommandExecutor = {
        async execute(command, args, options) {
          if (args.includes("reset")) {
            if (failure === "spawn") throw spawnFailure;
            return terminated;
          }
          return executeLocalCommand(command, args, options);
        },
      };
      const browser = new SourceBrowser(f.database.db, path.join(f.root, "state"), executor);
      await assert.rejects(browser.createCommit(f.issue, "repo", "rejected", { name: "Test", email: "test@example.test" }), (error: unknown) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.message, "workspace_git_index_cleanup_failed");
        assert.equal(error.outcome, "unknown");
        assert.ok(errorChain(error).includes(failure === "spawn" ? spawnFailure : terminated));
        return true;
      });
      assert.equal((await git(["-C", f.workspacePath, "ls-files", "-s", "--", "embedded"])).slice(0, 6), "160000");
      assert.equal(await git(["-C", f.workspacePath, "rev-parse", "HEAD"]), f.prepared.baseCommit);
    } finally {
      await f.close();
    }
  });
}

test("gitlink cleanup settles after cancellation without discarding unrelated index entries", async () => {
  const f = await fixture();
  try {
    await nestedRepository(path.join(f.workspacePath, "embedded"));
    await writeFile(path.join(f.workspacePath, "README.md"), "staged work\n");
    await git(["-C", f.workspacePath, "add", "--", "embedded", "README.md"]);
    const cancellation = new AbortController();
    const executor: CommandExecutor = {
      async execute(command, args, options) {
        const result = await executeLocalCommand(command, args, options);
        if (args.includes("diff-index")) cancellation.abort();
        return result;
      },
    };
    await assert.rejects(assertNoEmbeddedRepository(f.workspacePath, { executor, signal: cancellation.signal }), { message: "embedded_repository_not_allowed" });
    assert.equal(cancellation.signal.aborted, true);
    assert.equal(await git(["-C", f.workspacePath, "ls-files", "--", "embedded"]), "");
    assert.equal(await git(["-C", f.workspacePath, "show", ":README.md"]), "staged work");
  } finally {
    await f.close();
  }
});
