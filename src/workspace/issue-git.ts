import { execFile } from "node:child_process";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { executeLocalCommand } from "../process.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

const { gitOperationMs, gitOutputBytes } = issuePilotConfig.limits.process;
const exec = promisify(execFile);
const noHooks = ["-c", "core.hooksPath=/dev/null"];
const git = async (args: string[]) =>
  (await exec("git", [...noHooks, ...args], { timeout: gitOperationMs, maxBuffer: gitOutputBytes, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();

async function writeAtomicGitFile(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.close();
    await rename(temporary, file);
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await handle.close();
    } catch (failure) {
      failures.push(failure);
    }
    try {
      await rm(temporary, { force: true });
    } catch (failure) {
      failures.push(failure);
    }
    if (failures.length > 1) throw new AggregateError(failures, "workspace_git_file_cleanup_failed");
    throw error;
  }
}

/** Git runs outside SRT only after model-controlled metadata has been checked. */
export async function validateIssueGitStore(store: string, expectedUrl?: string): Promise<void> {
  if ((await realpath(store)) !== store || !(await lstat(store)).isDirectory()) throw new Error("workspace_git_store_invalid");
  await validateGitFiles(store);
  await validateGitConfiguration(store, expectedUrl);
  const hooks = await readdir(path.join(store, "hooks")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (hooks.some((name) => !name.endsWith(".sample"))) throw new Error("workspace_git_hooks_require_inspection");
}

async function validateGitFiles(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name),
      info = await lstat(file);
    if (info.isDirectory()) await validateGitFiles(file);
    else if (!info.isFile() || info.nlink !== 1) throw new Error("workspace_git_store_invalid");
  }
}

async function validateGitConfiguration(store: string, expectedUrl?: string, legacyShared = false): Promise<void> {
  // A planted include, filter, fsmonitor or hook must never execute in the trusted application.
  const file = path.join(store, "config");
  if (!(await lstat(file)).isFile()) throw new Error("workspace_git_configuration_invalid");
  const config = await git(["config", "--file", file, "--no-includes", "--null", "--list"]);
  for (const entry of config.split("\0").filter(Boolean)) {
    const split = entry.indexOf("\n"),
      key = entry.slice(0, split),
      value = entry.slice(split + 1);
    if (split < 0) throw new Error("workspace_git_configuration_invalid");
    const tracking = /^branch\.(.+)\.(remote|merge)$/.exec(key);
    // Historical shared repositories carry baseline tracking and operator/IDE settings. None are copied to the private store.
    if (
      legacyShared &&
      ((tracking?.[2] === "merge" && value.startsWith("refs/heads/")) ||
        (/^branch\..+\.vscode-merge-base$/.test(key) && value.startsWith("origin/")) ||
        (key === "core.logallrefupdates" && ["true", "false"].includes(value)) ||
        (key === "core.hookspath" && /^[a-zA-Z0-9/._-]+$/.test(value)) ||
        ((key === "user.name" || key === "user.email") && !value.includes("\n")))
    )
      continue;
    const valid =
      key === "core.repositoryformatversion"
        ? ["0", "1"].includes(value)
        : key === "core.filemode" || key === "extensions.relativeworktrees"
          ? ["true", "false"].includes(value)
          : key === "core.bare"
            ? value === "true"
            : key === "remote.origin.url"
              ? expectedUrl === undefined || value === expectedUrl
              : key === "remote.origin.fetch"
                ? value === "+refs/heads/*:refs/remotes/origin/*"
                : tracking
                  ? value === (tracking[2] === "remote" ? "origin" : `refs/heads/${tracking[1]}`)
                  : false;
    if (!valid) throw new Error("workspace_git_configuration_invalid");
  }
}

/** Check both links of a registered worktree before trusting Git commands in it. */
async function readGitPointer(file: string): Promise<string> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("workspace_git_binding_invalid");
  return readFile(file, "utf8");
}

async function linkedWorktreeMetadata(store: string, workspace: string): Promise<string> {
  const pointerFile = path.join(workspace, ".git");
  if ((await realpath(workspace)) !== workspace || (await realpath(store)) !== store) throw new Error("workspace_git_binding_invalid");
  const pointer = (await readGitPointer(pointerFile)).trim();
  if (!pointer.startsWith("gitdir: ")) throw new Error("workspace_git_binding_invalid");
  const directory = path.resolve(workspace, pointer.slice(8));
  if (path.dirname(directory) !== path.join(store, "worktrees") || (await realpath(directory)) !== directory) throw new Error("workspace_git_binding_invalid");
  const common = await readGitPointer(path.join(directory, "commondir"));
  const backPointer = await readGitPointer(path.join(directory, "gitdir"));
  if (path.resolve(directory, common.trim()) !== store || path.resolve(directory, backPointer.trim()) !== pointerFile) throw new Error("workspace_git_binding_invalid");
  return directory;
}

export async function readLinkedWorktreeHead(store: string, workspace: string): Promise<string> {
  return (await readGitPointer(path.join(await linkedWorktreeMetadata(store, workspace), "HEAD"))).trim();
}

export async function validateIssueWorktreeBinding(store: string, workspace: string, branch: string): Promise<void> {
  const head = await readLinkedWorktreeHead(store, workspace);
  if (head !== `ref: refs/heads/${branch}`) throw new Error("workspace_branch_does_not_match_issue_policy");
}

/** Resolve an exact local branch in one Git call. Probe failures to distinguish absence from damage. */
export async function readIssueBranchCommit(store: string, branch: string): Promise<string> {
  const ref = `refs/heads/${branch}`;
  try {
    return await git(["-C", store, "show-ref", "--verify", "--hash", "--", ref]);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 128) throw error;
    try {
      await git(["-C", store, "show-ref", "--exists", ref]);
    } catch (probe) {
      if ((probe as { code?: unknown } | null)?.code === 2) throw new Error("working_branch_not_found", { cause: error });
      throw probe;
    }
    throw error;
  }
}

export const publishedIssueBranchFile = "issue-pilot-published.json";

export async function readIssuePublicationCommit(store: string, branch: string): Promise<string | null> {
  const marker: unknown = JSON.parse(await readFile(path.join(store, publishedIssueBranchFile), "utf8"));
  if (
    !marker ||
    typeof marker !== "object" ||
    !("branch" in marker) ||
    marker.branch !== branch ||
    !("commit" in marker) ||
    (marker.commit !== null && (typeof marker.commit !== "string" || !/^[a-f0-9]{40}$/.test(marker.commit)))
  )
    throw new Error("workspace_git_publication_invalid");
  return marker.commit;
}

/**
 * Import objects, then compare-and-swap only the branch this store was created for.
 * Callers that already validated this store in the same operation pass `storeValidated`.
 */
export async function publishIssueBranch(sharedStore: string, privateStore: string, branch: string, storeValidated = false): Promise<string> {
  if (!storeValidated) await validateIssueGitStore(privateStore);
  const markerFile = path.join(privateStore, publishedIssueBranchFile);
  const published = await readIssuePublicationCommit(privateStore, branch);
  const commit = await readIssueBranchCommit(privateStore, branch);
  const current = await readIssueBranchCommit(sharedStore, branch).catch((error: unknown) => {
    if (error instanceof Error && error.message === "working_branch_not_found") return null;
    throw error;
  });
  if (current !== published && current !== commit) throw new Error("working_branch_changed_outside_issue");
  if (current !== commit) {
    await git(["-C", sharedStore, "fetch", "--no-tags", privateStore, `refs/heads/${branch}`]);
    await git(["-C", sharedStore, "update-ref", `refs/heads/${branch}`, commit, current ?? "0".repeat(40)]);
  }
  if (published !== commit || ((await lstat(markerFile)).mode & 0o7777) !== 0o600) await writeAtomicGitFile(markerFile, JSON.stringify({ branch, commit }) + "\n");
  return commit;
}

async function readIndexObjects(workspace: string): Promise<Set<string>> {
  const objects = new Set<string>();
  let pending = "";
  const listed = await executeLocalCommand("git", [...noHooks, "-C", workspace, "ls-files", "--stage", "-z"], {
    timeout: gitOperationMs,
    maxOutputBytes: null,
    onStdout: (chunk) => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\0")) >= 0) {
        const entry = pending.slice(0, end);
        pending = pending.slice(end + 1);
        const match = /^([0-9]{6}) ([a-f0-9]{40}) [0-3]\t/.exec(entry);
        if (!match) throw new Error("workspace_git_index_invalid");
        if (match[1] !== "160000" && !/^0+$/.test(match[2]!)) objects.add(match[2]!);
      }
    },
  });
  if (listed.code || pending) throw new Error("workspace_git_index_invalid");
  return objects;
}

async function initializePrivateStore(
  sharedStore: string,
  temporary: string,
  branch: string,
  commit: string,
  base: string,
  workspace?: string,
  publishedCommit: string | null = commit,
): Promise<void> {
  // Use only the reviewed branch. Baseline objects remain shared; Issue commits and staged blobs are packed locally.
  await git(["init", "--bare", "--object-format=sha1", `--initial-branch=${branch}`, temporary]);
  await writeFile(path.join(temporary, "objects/info/alternates"), `${path.relative(path.join(temporary, "objects"), path.join(sharedStore, "objects"))}\n`);
  const origin = await git(["-C", sharedStore, "remote", "get-url", "origin"]);
  await git(["-C", temporary, "remote", "add", "origin", origin]);
  await git(["-C", temporary, "update-ref", `refs/heads/${branch}`, commit]);
  await writeFile(path.join(temporary, publishedIssueBranchFile), JSON.stringify({ branch, commit: publishedCommit }) + "\n", { mode: 0o600 });
  await git(["-C", temporary, "fetch", "--no-tags", sharedStore, "+refs/remotes/origin/*:refs/remotes/origin/*"]);
  const objects = workspace ? await readIndexObjects(workspace) : new Set<string>();
  if (commit === base && !objects.size) return;
  const packed = await executeLocalCommand("git", [...noHooks, "-C", sharedStore, "pack-objects", "--revs", "--non-empty", path.join(temporary, "objects/pack/pack")], {
    timeout: gitOperationMs,
    input: Buffer.from([commit, `^${base}`, ...objects].join("\n") + "\n"),
  });
  if (packed.code) throw new Error("workspace_git_object_preservation_failed", { cause: new Error(packed.stderr) });
}

export type LegacyIssueBranch = { sharedStore: string; privateStore: string; branch: string; commit: string; base: string; workspace?: string };

/** Inspect a reviewed legacy binding without running Git in its worktree or changing any refs. */
export async function inspectLegacyIssueBranch(input: LegacyIssueBranch, url: string): Promise<void> {
  const { sharedStore, branch, commit, base, workspace } = input;
  const objects = path.join(sharedStore, "objects");
  if (!(await lstat(objects)).isDirectory() || (await realpath(objects)) !== objects) throw new Error("workspace_git_store_invalid");
  await validateGitConfiguration(sharedStore, url, true);
  if ((await readIssueBranchCommit(sharedStore, branch)) !== commit) throw new Error("legacy_issue_branch_changed");
  if ((await git(["-C", sharedStore, "cat-file", "-t", base])) !== "commit" || (await git(["-C", sharedStore, "cat-file", "-t", commit])) !== "commit") throw new Error("legacy_issue_commit_invalid");
  if (workspace) {
    const metadata = await linkedWorktreeMetadata(sharedStore, workspace);
    await validateGitFiles(metadata);
    await validateIssueWorktreeBinding(sharedStore, workspace, branch);
  } else if ((await git(["-C", sharedStore, "worktree", "list", "--porcelain", "-z"])).split("\0").includes(`branch refs/heads/${branch}`)) {
    throw new Error("legacy_released_branch_has_worktree");
  }
}

/** Install a released Issue store without creating a worktree or modifying the shared ref. */
export async function preserveReleasedIssueBranch(input: LegacyIssueBranch): Promise<void> {
  const { sharedStore, privateStore, branch, commit, base } = input;
  const temporary = await privateStoreStagingPath(privateStore);
  try {
    await initializePrivateStore(sharedStore, temporary, branch, commit, base);
    if ((await readIssueBranchCommit(sharedStore, branch)) !== commit) throw new Error("legacy_issue_branch_changed");
    await rename(temporary, privateStore);
  } catch (error) {
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "workspace_git_isolation_rollback_failed");
    }
    throw error;
  }
}

/** Create a new branch directly in its private store. No shared branch or worktree is created. */
export async function createPrivateIssueBranch(sharedStore: string, privateStore: string, branch: string, base: string): Promise<void> {
  const temporary = await privateStoreStagingPath(privateStore);
  try {
    await initializePrivateStore(sharedStore, temporary, branch, base, base, undefined, null);
    await rename(temporary, privateStore);
  } catch (error) {
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "workspace_git_creation_rollback_failed");
    }
    throw error;
  }
}

async function privateStoreStagingPath(privateStore: string): Promise<string> {
  try {
    await lstat(privateStore);
    throw new Error("workspace_git_store_already_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(privateStore), { recursive: true, mode: 0o700 });
  if ((await realpath(path.dirname(privateStore))) !== path.dirname(privateStore)) throw new Error("workspace_git_store_invalid");
  return `${privateStore}.preparing-${randomUUID()}`;
}

/** Move a validated linked worktree's mutable Git state into its Issue. No shared write grant is needed. */
export async function isolateIssueWorktree(sharedStore: string, privateStore: string, workspace: string, branch: string, base: string, expectedCommit?: string): Promise<void> {
  const pointerFile = path.join(workspace, ".git");
  const pointer = await readGitPointer(pointerFile);
  if (!pointer.startsWith("gitdir: ")) throw new Error("workspace_git_binding_invalid");
  const metadata = path.resolve(workspace, pointer.slice(8).trim());
  const privateMetadata = path.join(privateStore, "worktrees", path.basename(metadata));
  if (metadata === privateMetadata) {
    await validateIssueWorktreeBinding(privateStore, workspace, branch);
    return;
  }
  await validateIssueWorktreeBinding(sharedStore, workspace, branch);
  const commit = await readIssueBranchCommit(sharedStore, branch);
  if (expectedCommit !== undefined && commit !== expectedCommit) throw new Error("legacy_issue_branch_changed");
  const temporary = await privateStoreStagingPath(privateStore);
  let installed = false,
    switched = false;
  try {
    await initializePrivateStore(sharedStore, temporary, branch, commit, base, workspace);
    await mkdir(path.join(temporary, "worktrees"), { recursive: true });
    await cp(metadata, path.join(temporary, "worktrees", path.basename(metadata)), { recursive: true, errorOnExist: true, force: false });
    if (expectedCommit !== undefined) {
      if ((await readIssueBranchCommit(sharedStore, branch)) !== expectedCommit) throw new Error("legacy_issue_branch_changed");
      await validateIssueWorktreeBinding(sharedStore, workspace, branch);
    }
    await rename(temporary, privateStore);
    installed = true;
    await writeFile(path.join(privateMetadata, "commondir"), "../..\n");
    await writeFile(path.join(privateMetadata, "gitdir"), `${path.relative(privateMetadata, pointerFile)}\n`);
    await writeAtomicGitFile(pointerFile, `gitdir: ${path.relative(workspace, privateMetadata)}\n`);
    switched = true;
    await git(["-C", workspace, "rev-parse", "--verify", "HEAD"]);
    // Preserve the old registration as recovery evidence without retaining a false shared worktree binding.
    await rename(metadata, path.join(privateStore, "legacy-worktree-registration"));
  } catch (error) {
    const failures: unknown[] = [error];
    if (switched)
      try {
        await writeAtomicGitFile(pointerFile, pointer);
      } catch (failure) {
        failures.push(failure);
      }
    if (installed && failures.length === 1)
      try {
        await rm(privateStore, { recursive: true });
      } catch (failure) {
        failures.push(failure);
      }
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch (failure) {
      failures.push(failure);
    }
    if (failures.length > 1) throw new AggregateError(failures, "workspace_git_isolation_rollback_failed");
    throw error;
  }
}
