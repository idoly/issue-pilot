import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issueRepositories, issues, serviceDeployments, services } from "../../src/db/schema.ts";
import { claimIssueRoot } from "../../src/workspace/state.ts";
import { WorktreeManager, repositoryStorePath } from "../../src/workspace/git.ts";
import { IssueProjectManager } from "../../src/workspace/project.ts";
import { validateIssueGitStore } from "../../src/workspace/issue-git.ts";
import { issueNativeTools } from "../../src/agent/native-tools.ts";
import { shellQuote } from "../../src/agent/issue-sandbox.ts";
import { createWorkspaceTool } from "../../src/agent/workspace-tool.ts";
import { gitIdentityEnvironment } from "../../src/agent/pi-session.ts";

function exitCode(result: { structuredContent?: unknown }): unknown {
  const data = result.structuredContent;
  assert.ok(data && typeof data === "object" && "exit_code" in data);
  return data.exit_code;
}

const exec = promisify(execFile);
const git = async (args: string[]) => (await exec("git", args)).stdout.trim();

test("conversation Git cannot create or switch branches and stages and commits only through the bound repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-private-git-"));
  let database: Awaited<ReturnType<typeof openApplicationDatabase>> | undefined;
  try {
    const source = path.join(root, "source"),
      state = path.join(root, "state");
    await git(["init", "-b", "main", source]);
    await writeFile(path.join(source, "file.txt"), "before");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial"]);
    const manager = new WorktreeManager(state);
    const input = { issueKey: "ISSUE-20261023-001", workspaceName: "repo", url: source, baseBranch: "main", mode: "hotfix" as const };
    await claimIssueRoot(state, input.issueKey);
    const own = await manager.prepare(input);
    await claimIssueRoot(state, "ISSUE-20261023-002");
    const other = await manager.prepare({ ...input, issueKey: "ISSUE-20261023-002" });
    const shared = repositoryStorePath(state, source);
    const before = own.baseCommit;
    await git(["-C", own.cachePath, "branch", "fixture-existing", own.workingBranch!]);
    const runtimeRoot = path.dirname(own.workspacePath);
    database = await openApplicationDatabase(path.join(state, "issues.db"));
    const [environment] = await database.db.select().from(environments).where(eq(environments.key, "dev"));
    const [service] = await database.db.insert(services).values({ key: "git-fixture", name: "Git fixture" }).returning();
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
    const [issue] = await database.db
      .insert(issues)
      .values({
        key: input.issueKey,
        title: "Git fixture",
        type: "defect_fix",
        serviceId: service!.id,
        environmentId: environment!.id,
        reporterSubject: issuePilotConfig.bootstrapUser.subject,
      })
      .returning();
    await database.db
      .insert(issueRepositories)
      .values({ issueId: issue!.id, url: source, baseBranch: "main", workingBranch: own.workingBranch, localPath: own.workspacePath, workspaceName: "repo", commitBefore: own.baseCommit });
    const tool = await createWorkspaceTool(database.db, issue!, "dev", new IssueProjectManager(database.db, state), {
      stateRoot: state,
      runtimeRoot,
      commitEnvironment: gitIdentityEnvironment({ name: "Fixture", email: "fixture@example.test" }),
      networkDomains: [],
    });
    const update = (input: Record<string, unknown>, signal?: AbortSignal) => tool.execute("fixture", { repository: "repo", ...input } as never, signal, undefined, {} as never);
    const bash = issueNativeTools({ writeRoot: runtimeRoot, stateRoot: state, readRoots: [path.join(shared, "objects")] }, () => ({ GIT_OPTIONAL_LOCKS: "0" })).find((tool) => tool.name === "bash")!;
    const run = (command: string) => bash.execute("fixture", { command }, undefined, undefined, {} as never);
    const baseline = await run(`test "$(git -C repo show HEAD:file.txt)" = before && test ! -r ${shellQuote(path.join(shared, "config"))}`);
    assert.equal(exitCode(baseline), 0, JSON.stringify(baseline));
    const otherBranch = await run('test "$(git -C repo show fixture-existing:file.txt)" = before && git -C repo diff --exit-code HEAD fixture-existing');
    assert.equal(exitCode(otherBranch), 0, JSON.stringify(otherBranch));
    const originalRefs = await git(["-C", own.cachePath, "show-ref", "--heads"]);
    for (const command of ["branch fixture-new", "switch -c fixture-new", "switch fixture-existing", "checkout --detach HEAD", "update-ref refs/heads/fixture-new HEAD", "add file.txt"]) {
      const result = await run(`git -C repo ${command}`);
      assert.notEqual(exitCode(result), 0, command);
    }
    assert.notEqual(exitCode(await run("mv repo moved-repo")), 0);
    const metadata = path.resolve(own.workspacePath, (await readFile(path.join(own.workspacePath, ".git"), "utf8")).slice(8).trim());
    assert.notEqual(exitCode(await run(`printf 'ref: refs/heads/fixture-existing\n' > ${shellQuote(path.join(metadata, "HEAD"))}`)), 0);
    assert.equal(await git(["-C", own.cachePath, "show-ref", "--heads"]), originalRefs);
    assert.equal(await git(["-C", own.workspacePath, "branch", "--show-current"]), own.workingBranch);
    assert.equal(exitCode(await run("printf after > repo/file.txt")), 0);
    await assert.rejects(update({ operation: "switch", branch: "fixture-existing" }), /invalid_workspace_input/);
    await assert.rejects(update({ operation: "push", ref: "refs/heads/main" }), /invalid_workspace_input/);
    await assert.rejects(update({ operation: "push" }), /personal_git_ssh_credentials_required/);
    await assert.rejects(update({ operation: "stage", paths: ["file.txt"] }, AbortSignal.abort()), { name: "AbortError" });
    await update({ operation: "stage", paths: ["file.txt"] });
    assert.equal(await git(["-C", own.workspacePath, "show", ":file.txt"]), "after");
    await update({ operation: "unstage", paths: ["file.txt"] });
    assert.equal(await git(["-C", own.workspacePath, "show", ":file.txt"]), "before");
    await git(["-C", own.workspacePath, "switch", "fixture-existing"]);
    await assert.rejects(update({ operation: "stage", paths: ["file.txt"] }), (error: Error) => (error.cause as Error)?.message === "workspace_branch_does_not_match_issue_policy");
    assert.equal(await git(["-C", own.workspacePath, "branch", "--show-current"]), "fixture-existing");
    await git(["-C", own.workspacePath, "switch", own.workingBranch!]);
    await update({ operation: "stage", paths: ["file.txt"] });
    await update({ operation: "commit", message: "更新文件" });
    const after = await git(["-C", own.workspacePath, "rev-parse", "HEAD"]);
    assert.notEqual(after, before);
    await assert.rejects(git(["-C", shared, "show-ref", "--exists", `refs/heads/${own.workingBranch}`]), { code: 2 });
    const sharedConfig = path.join(shared, "config");
    const configBefore = await readFile(sharedConfig, "utf8");
    // The sandbox may create an ephemeral file at a hidden path; it cannot modify the host file.
    await run(`printf compromised >> ${shellQuote(sharedConfig)}`);
    assert.equal(await readFile(sharedConfig, "utf8"), configBefore);
    for (const file of [path.join(shared, "objects", "unexpected"), path.join(other.cachePath, "config"), path.join(own.cachePath, "config"), path.join(own.cachePath, "hooks", "pre-commit")]) {
      const denied = await run(`printf compromised >> ${shellQuote(file)}`);
      assert.notEqual(exitCode(denied), 0, file);
    }
    assert.equal(await git(["-C", own.workspacePath, "log", "-1", "--format=%an <%ae> %s"]), "Fixture <fixture@example.test> 更新文件");
    const finalCommit = after;
    await manager.remove(source, own.workspacePath, own.workingBranch!);
    assert.equal(await git(["-C", shared, "rev-parse", `refs/heads/${own.workingBranch}`]), finalCommit);
    const restored = await manager.prepare({ ...input, workingBranch: own.workingBranch!, existingBaseCommit: own.baseCommit });
    assert.equal(await git(["-C", restored.workspacePath, "rev-parse", "HEAD"]), finalCommit);
    assert.equal(await readFile(path.join(restored.workspacePath, "file.txt"), "utf8"), "after");
    await git(["-C", own.cachePath, "update-ref", `refs/remotes/origin/${own.workingBranch}`, finalCommit]);
    await git(["-C", own.cachePath, "config", `branch.${own.workingBranch}.remote`, "origin"]);
    await git(["-C", own.cachePath, "config", `branch.${own.workingBranch}.merge`, `refs/heads/${own.workingBranch}`]);
    await validateIssueGitStore(own.cachePath, source);
    assert.equal(await git(["-C", restored.workspacePath, "rev-parse", "--abbrev-ref", "@{upstream}"]), `origin/${own.workingBranch}`);
    await git(["-C", own.cachePath, "config", "core.fsmonitor", "fixture-unsafe-command"]);
    await assert.rejects(validateIssueGitStore(own.cachePath, source), /workspace_git_configuration_invalid/);
    await git(["-C", own.cachePath, "config", "--unset", "core.fsmonitor"]);
    const pointerFile = path.join(restored.workspacePath, ".git"),
      pointer = await readFile(pointerFile, "utf8");
    const otherMetadata = path.join(other.cachePath, "worktrees", path.basename(other.workspacePath));
    const backPointer = await readFile(path.join(otherMetadata, "gitdir"), "utf8");
    await writeFile(pointerFile, `gitdir: ${otherMetadata}\n`);
    await assert.rejects(
      manager.prepare({ ...input, workingBranch: own.workingBranch!, existingBaseCommit: own.baseCommit, existingWorkspacePath: restored.workspacePath }),
      /workspace_git_binding_invalid/,
    );
    assert.equal(await readFile(path.join(otherMetadata, "gitdir"), "utf8"), backPointer);
    await writeFile(pointerFile, pointer);
    await symlink(shared, path.join(own.cachePath, "untrusted-link"));
    await assert.rejects(validateIssueGitStore(own.cachePath), /workspace_git_store_invalid/);
  } finally {
    await database?.close();
    await rm(root, { recursive: true, force: true });
  }
});
