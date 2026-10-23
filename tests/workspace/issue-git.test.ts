import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { WorktreeManager, repositoryStorePath } from "../../src/workspace/git.ts";
import { validateIssueGitStore } from "../../src/workspace/issue-git.ts";
import { issueNativeTools } from "../../src/agent/native-tools.ts";
import { createPersonalGitEnvironment } from "../../src/workspace/git-credentials.ts";
import { shellQuote } from "../../src/agent/issue-sandbox.ts";

function exitCode(result: { structuredContent?: unknown }): unknown {
  const data = result.structuredContent;
  assert.ok(data && typeof data === "object" && "exit_code" in data);
  return data.exit_code;
}

const exec = promisify(execFile);
const git = async (args: string[]) => (await exec("git", args)).stdout.trim();

test("native Git stages and commits in its Issue while shared and other Issue stores stay protected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-private-git-"));
  try {
    const source = path.join(root, "source"), state = path.join(root, "state");
    await git(["init", "-b", "main", source]);
    await writeFile(path.join(source, "file.txt"), "before");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial"]);
    const manager = new WorktreeManager(state);
    const input = { issueKey: "ISSUE-20261023-001", workspaceName: "repo", url: source, baseBranch: "main", mode: "hotfix" as const };
    const own = await manager.prepare(input);
    const other = await manager.prepare({ ...input, issueKey: "ISSUE-20261023-002" });
    const shared = repositoryStorePath(state, source);
    const before = await git(["-C", shared, "rev-parse", `refs/heads/${own.workingBranch}`]);
    const bash = issueNativeTools({ writeRoot: path.dirname(own.workspacePath) }, () => ({ GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" })).find(tool => tool.name === "bash")!;
    const run = (command: string) => bash.execute("fixture", { command }, undefined, undefined, {} as never);
    const result = await run("printf after > repo/file.txt && git -C repo add file.txt && git -C repo commit -m change");
    assert.equal(exitCode(result), 0, JSON.stringify(result));
    const after = await git(["-C", own.workspacePath, "rev-parse", "HEAD"]);
    assert.notEqual(after, before);
    assert.equal(await git(["-C", shared, "rev-parse", `refs/heads/${own.workingBranch}`]), before);
    for (const file of [path.join(shared, "config"), path.join(other.cachePath, "config"), path.join(own.cachePath, "config"), path.join(own.cachePath, "hooks", "pre-commit")]) {
      const denied = await run(`printf compromised >> ${shellQuote(file)}`);
      assert.notEqual(exitCode(denied), 0, file);
    }
    const amended = await run("git -C repo commit --amend -m amended");
    assert.equal(exitCode(amended), 0, JSON.stringify(amended));
    const finalCommit = await git(["-C", own.workspacePath, "rev-parse", "HEAD"]);
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
    const pointerFile = path.join(restored.workspacePath, ".git"), pointer = await readFile(pointerFile, "utf8");
    const otherMetadata = path.join(other.cachePath, "worktrees", path.basename(other.workspacePath));
    const backPointer = await readFile(path.join(otherMetadata, "gitdir"), "utf8");
    await writeFile(pointerFile, `gitdir: ${otherMetadata}\n`);
    await assert.rejects(manager.prepare({ ...input, workingBranch: own.workingBranch!, existingBaseCommit: own.baseCommit, existingWorkspacePath: restored.workspacePath }), /workspace_git_binding_invalid/);
    assert.equal(await readFile(path.join(otherMetadata, "gitdir"), "utf8"), backPointer);
    await writeFile(pointerFile, pointer);
    await symlink(shared, path.join(own.cachePath, "untrusted-link"));
    await assert.rejects(validateIssueGitStore(own.cachePath), /workspace_git_store_invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("only the selected personal SSH identity is readable inside native execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-private-ssh-"));
  let own, other;
  try {
    const generated = path.join(root, "generated");
    await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", generated]);
    const key = await readFile(generated, "utf8");
    own = await createPersonalGitEnvironment({ gitPrivateKey: key }, ["git@example.test:repo.git"]);
    other = await createPersonalGitEnvironment({ gitPrivateKey: key }, ["git@example.test:repo.git"]);
    const ownKey = path.join(own.readRoots![0]!, "identity"), otherKey = path.join(other.readRoots![0]!, "identity");
    const bash = issueNativeTools({ writeRoot: root, readRoots: own.readRoots ?? [] }, () => own!.env).find(tool => tool.name === "bash")!;
    const result = await bash.execute("ssh", { command: `ssh-keygen -y -f ${shellQuote(ownKey)} >/dev/null && test ! -r ${shellQuote(otherKey)} && test -r ${shellQuote(path.join(own.readRoots![0]!, "known_hosts"))}` }, undefined, undefined, {} as never);
    assert.equal(exitCode(result), 0, JSON.stringify(result));
  } finally { await Promise.all([own?.close(), other?.close()]); await rm(root, { recursive: true, force: true }); }
});
