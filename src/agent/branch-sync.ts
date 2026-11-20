import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { OperationError } from "../operation-error.ts";
import type { CommandExecutionResult } from "../process.ts";
import { readIssueBranchCommit, readIssueMergeHead } from "../workspace/issue-git.ts";
import { WorktreeManager } from "../workspace/git.ts";

/** Fixed commands only. The caller holds the Issue command queue throughout; only fetch receives SSH. */
export async function syncBoundBranch(
  input: { operation: "sync" } | { operation: "merge"; localTip: string; remoteTip: string },
  repository: { stateRoot: string; root: string; store: string; branch: string; url: string },
  git: (args: string[], network?: boolean, allowExitOne?: boolean) => Promise<CommandExecutionResult>,
  signal: AbortSignal,
) {
  const { root, store, branch, url } = repository;
  const localTip = await readIssueBranchCommit(store, branch);
  const pendingResult = async (mergeHead: string) => {
    const unmerged = (await git(["ls-files", "--unmerged", "-z"])).stdout;
    const paths = [
      ...new Set(
        unmerged
          .split("\0")
          .filter(Boolean)
          .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
      ),
    ];
    return {
      status: paths.length ? "conflicts" : "ready_to_commit",
      localTip,
      mergeHead,
      conflictCount: paths.length,
      conflictPaths: paths.slice(0, issuePilotConfig.limits.sourceBrowser.changeFiles),
    };
  };
  const pending = await readIssueMergeHead(store, root);
  if (input.operation === "merge" && (localTip !== input.localTip || (pending && pending !== input.remoteTip))) throw new Error("workspace_git_sync_tips_changed");
  // Reopening the Issue or repeating the request must not restart a merge or replace its second parent.
  if (pending) return pendingResult(pending);

  const ref = `refs/heads/${branch}`,
    tracking = `refs/remotes/origin/${branch}`;
  // Override the configured wildcard refmap. Only this private tracking ref may move, including when
  // the server rewound it. A failed fetch never authorizes using its previous value.
  await git(
    ["-c", "remote.origin.followRemoteHEAD=never", "fetch", "--atomic", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--refmap=", "--", "origin", `${ref}:${tracking}`],
    true,
  );
  const remoteTip = (await git(["show-ref", "--verify", "--hash", "--", tracking])).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(remoteTip)) throw new Error("workspace_git_remote_ref_invalid");
  if (input.operation === "merge" && remoteTip !== input.remoteTip) throw new Error("workspace_git_sync_tips_changed");
  const counts = (await git(["rev-list", "--left-right", "--count", `${localTip}...${remoteTip}`, "--"])).stdout.trim();
  if (!/^\d+\s+\d+$/.test(counts)) throw new Error("workspace_git_comparison_invalid");
  const [ahead, behind] = counts.split(/\s+/).map(Number) as [number, number];
  const tips = { localTip, remoteTip, ahead, behind };
  const unique = async (from: string, exclude: string) =>
    (await git(["rev-list", `--max-count=${issuePilotConfig.limits.sourceBrowser.historyCommits}`, `${exclude}..${from}`, "--"])).stdout.trim().split("\n").filter(Boolean);
  const comparison = async (status: string) => ({ status, ...tips, localOnly: ahead ? await unique(localTip, remoteTip) : [], remoteOnly: behind ? await unique(remoteTip, localTip) : [] });
  if (input.operation === "merge" && (!ahead || !behind)) throw new Error("workspace_git_merge_requires_divergence");
  if (!behind) return comparison(ahead ? "ahead" : "up_to_date");
  if (ahead && input.operation === "sync") return comparison("diverged");
  if (input.operation === "merge" && (await git(["merge-base", localTip, remoteTip], false, true)).code === 1) throw new Error("workspace_git_unrelated_histories");

  // Use the same clean-index, ignored/untracked and nonempty-gitlink checks as lifecycle mutations.
  const worktrees = new WorktreeManager(repository.stateRoot);
  try {
    await worktrees.withSignal(signal, () => worktrees.withGitEnvironment({ GIT_CONFIG_GLOBAL: "/dev/null" }, () => worktrees.assertClean(url, root, branch)));
  } catch (error) {
    if (error instanceof Error && error.message === "workspace_has_changes") return comparison("dirty");
    throw error;
  }
  if ((await readIssueBranchCommit(store, branch)) !== localTip) throw new Error("workspace_git_sync_tips_changed");
  signal.throwIfAborted();
  const merging = input.operation === "merge";
  try {
    const result = await git(
      ["merge", ...(merging ? ["--no-ff", "--no-commit"] : ["--ff-only"]), "--no-autostash", "--no-overwrite-ignore", "--no-stat", "--no-edit", "--", remoteTip],
      false,
      merging,
    );
    if (!merging && (await readIssueBranchCommit(store, branch)) === remoteTip) return { status: "fast_forwarded", previousTip: localTip, localTip: remoteTip, remoteTip };
    if (merging && (await readIssueMergeHead(store, root)) === remoteTip && (await readIssueBranchCommit(store, branch)) === localTip) {
      const state = await pendingResult(remoteTip);
      if (result.code === 0 || state.conflictCount > 0) return state;
    }
    throw new Error("workspace_git_unexpected_merge_state");
  } catch (cause) {
    // Git may already have written files or refs. Preserve them; never hard-reset or claim a clean rollback.
    throw new OperationError("workspace_git_sync_requires_inspection", "unknown", { cause });
  }
}
