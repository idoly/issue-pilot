import { execFile } from "node:child_process";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { executeLocalCommand } from "../process.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

const { gitOperationMs, gitOutputBytes } = issuePilotConfig.limits.process;
const exec = promisify(execFile);
const git = async (args: string[]) => (await exec("git", args, { timeout: gitOperationMs, maxBuffer: gitOutputBytes, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();

async function writeAtomicGitFile(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.close();
    await rename(temporary, file);
  } catch (error) {
    const failures: unknown[] = [error];
    try { await handle.close(); } catch (failure) { failures.push(failure); }
    try { await rm(temporary, { force: true }); } catch (failure) { failures.push(failure); }
    if (failures.length > 1) throw new AggregateError(failures, "workspace_git_file_cleanup_failed");
    throw error;
  }
}

/** Git runs outside SRT only after model-controlled metadata has been checked. */
export async function validateIssueGitStore(store: string, expectedUrl?: string): Promise<void> {
  if (await realpath(store) !== store || !(await lstat(store)).isDirectory()) throw new Error("workspace_git_store_invalid");
  const scan = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name), info = await lstat(file);
      if (info.isDirectory()) await scan(file);
      else if (!info.isFile() || info.nlink !== 1) throw new Error("workspace_git_store_invalid");
    }
  };
  await scan(store);
  // A planted include, filter, fsmonitor or hook must never execute in the trusted application.
  const config = await git(["config", "--file", path.join(store, "config"), "--no-includes", "--null", "--list"]);
  for (const entry of config.split("\0").filter(Boolean)) {
    const split = entry.indexOf("\n"), key = entry.slice(0, split), value = entry.slice(split + 1);
    const tracking = /^branch\.(.+)\.(remote|merge)$/.exec(key);
    const valid = key === "core.repositoryformatversion" ? ["0", "1"].includes(value)
      : key === "core.filemode" || key === "extensions.relativeworktrees" ? ["true", "false"].includes(value)
      : key === "core.bare" ? value === "true"
      : key === "remote.origin.url" ? expectedUrl === undefined || value === expectedUrl
      : key === "remote.origin.fetch" ? value === "+refs/heads/*:refs/remotes/origin/*"
      : tracking ? value === (tracking[2] === "remote" ? "origin" : `refs/heads/${tracking[1]}`)
      : false;
    if (split < 0 || !valid) throw new Error("workspace_git_configuration_invalid");
  }
  const hooks = await readdir(path.join(store, "hooks")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  if (hooks.some(name => !name.endsWith(".sample"))) throw new Error("workspace_git_hooks_require_inspection");
}

export async function validateIssueWorktreeBinding(store: string, workspace: string, branch: string): Promise<void> {
  const pointerFile = path.join(workspace, ".git");
  if (!(await lstat(pointerFile)).isFile() || await realpath(store) !== store) throw new Error("workspace_git_binding_invalid");
  const pointer = (await readFile(pointerFile, "utf8")).trim();
  if (!pointer.startsWith("gitdir: ")) throw new Error("workspace_git_binding_invalid");
  const directory = path.resolve(workspace, pointer.slice(8));
  if (path.dirname(directory) !== path.join(store, "worktrees") || await realpath(directory) !== directory) throw new Error("workspace_git_binding_invalid");
  const [common, backPointer, head] = await Promise.all(["commondir", "gitdir", "HEAD"].map(name => readFile(path.join(directory, name), "utf8")));
  if (path.resolve(directory, common!.trim()) !== store || path.resolve(directory, backPointer!.trim()) !== pointerFile) throw new Error("workspace_git_binding_invalid");
  if (head!.trim() !== `ref: refs/heads/${branch}`) throw new Error("workspace_branch_does_not_match_issue_policy");
}

export const publishedIssueBranchFile = "issue-pilot-published.json";

/** Import objects, then compare-and-swap only the branch this store was created for. */
export async function publishIssueBranch(sharedStore: string, privateStore: string, branch: string): Promise<void> {
  await validateIssueGitStore(privateStore);
  const markerFile = path.join(privateStore, publishedIssueBranchFile);
  const marker: unknown = JSON.parse(await readFile(markerFile, "utf8"));
  if (!marker || typeof marker !== "object" || !("branch" in marker) || marker.branch !== branch || !("commit" in marker) || typeof marker.commit !== "string" || !/^[a-f0-9]{40}$/.test(marker.commit)) throw new Error("workspace_git_publication_invalid");
  const commit = await git(["-C", privateStore, "rev-parse", `refs/heads/${branch}`]);
  const current = await git(["-C", sharedStore, "rev-parse", `refs/heads/${branch}`]);
  if (current !== marker.commit && current !== commit) throw new Error("working_branch_changed_outside_issue");
  if (current !== commit) {
    await git(["-C", sharedStore, "fetch", "--no-tags", privateStore, `refs/heads/${branch}`]);
    await git(["-C", sharedStore, "update-ref", `refs/heads/${branch}`, commit, current]);
  }
  await writeAtomicGitFile(markerFile, JSON.stringify({ branch, commit }) + "\n");
}

async function preserveIndexObjects(sharedStore: string, privateStore: string, workspace: string): Promise<void> {
  const objects = new Set<string>();
  let pending = "";
  const listed = await executeLocalCommand("git", ["-C", workspace, "ls-files", "--stage", "-z"], {
    timeout: gitOperationMs, maxOutputBytes: null,
    onStdout: chunk => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\0")) >= 0) {
        const entry = pending.slice(0, end); pending = pending.slice(end + 1);
        const match = /^([0-9]{6}) ([a-f0-9]{40}) [0-3]\t/.exec(entry);
        if (!match) throw new Error("workspace_git_index_invalid");
        if (match[1] !== "160000" && !/^0+$/.test(match[2]!)) objects.add(match[2]!);
      }
    },
  });
  if (listed.code || pending) throw new Error("workspace_git_index_invalid");
  if (!objects.size) return;
  // Keep staged/conflict blobs that are not reachable from shared refs; shared GC must not erase the private index.
  const exclusions = await git(["-C", sharedStore, "for-each-ref", "--format=^%(objectname)"]);
  const packed = await executeLocalCommand("git", ["-C", sharedStore, "pack-objects", "--revs", "--non-empty", path.join(privateStore, "objects/pack/pack")], {
    timeout: gitOperationMs, input: Buffer.from([...objects, exclusions].filter(Boolean).join("\n") + "\n"),
  });
  if (packed.code) throw new Error("workspace_git_index_preservation_failed", { cause: new Error(packed.stderr) });
}

/** Move a validated linked worktree's mutable Git state into its Issue. No shared write grant is needed. */
export async function isolateIssueWorktree(sharedStore: string, privateStore: string, workspace: string, branch: string): Promise<void> {
  const pointerFile = path.join(workspace, ".git");
  const pointer = await readFile(pointerFile, "utf8");
  if (!pointer.startsWith("gitdir: ")) throw new Error("workspace_git_binding_invalid");
  const metadata = path.resolve(workspace, pointer.slice(8).trim());
  const privateMetadata = path.join(privateStore, "worktrees", path.basename(metadata));
  const common = path.resolve(metadata, (await readFile(path.join(metadata, "commondir"), "utf8")).trim());
  if (common === privateStore) {
    await validateIssueWorktreeBinding(privateStore, workspace, branch);
    if (metadata !== privateMetadata) throw new Error("workspace_git_binding_invalid");
    await git(["-C", privateStore, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    return;
  }
  await validateIssueWorktreeBinding(sharedStore, workspace, branch);
  if (common !== sharedStore) throw new Error("workspace_git_binding_invalid");
  try {
    await lstat(privateStore);
    throw new Error("workspace_git_store_already_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${privateStore}.preparing-${randomUUID()}`;
  let installed = false, switched = false;
  try {
    await mkdir(path.dirname(privateStore), { recursive: true, mode: 0o700 });
    if (await realpath(path.dirname(privateStore)) !== path.dirname(privateStore)) throw new Error("workspace_git_store_invalid");
    // Alternates share read-only baseline objects; new objects and refs belong to this Issue.
    await git(["clone", "--bare", "--shared", sharedStore, temporary]);
    await writeFile(path.join(temporary, "objects/info/alternates"), `${path.relative(path.join(privateStore, "objects"), path.join(sharedStore, "objects"))}\n`);
    const origin = await git(["-C", sharedStore, "remote", "get-url", "origin"]);
    await git(["-C", temporary, "remote", "set-url", "origin", origin]);
    await git(["-C", temporary, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    await writeFile(path.join(temporary, publishedIssueBranchFile), JSON.stringify({ branch, commit: await git(["-C", sharedStore, "rev-parse", `refs/heads/${branch}`]) }) + "\n", { mode: 0o600 });
    // Bare clone copies heads but not remote-tracking refs used by base/diff calculations.
    await git(["-C", temporary, "fetch", "--no-tags", sharedStore, "+refs/remotes/origin/*:refs/remotes/origin/*"]);
    await mkdir(path.join(temporary, "worktrees"), { recursive: true });
    await preserveIndexObjects(sharedStore, temporary, workspace);
    await cp(metadata, path.join(temporary, "worktrees", path.basename(metadata)), { recursive: true, errorOnExist: true, force: false });
    await rename(temporary, privateStore); installed = true;
    await writeFile(path.join(privateMetadata, "commondir"), "../..\n");
    await writeFile(path.join(privateMetadata, "gitdir"), `${path.relative(privateMetadata, pointerFile)}\n`);
    await writeAtomicGitFile(pointerFile, `gitdir: ${path.relative(workspace, privateMetadata)}\n`);
    switched = true;
    await git(["-C", workspace, "rev-parse", "--verify", "HEAD"]);
    // Preserve the old registration as recovery evidence without retaining a false shared worktree binding.
    await rename(metadata, path.join(privateStore, "legacy-worktree-registration"));
  } catch (error) {
    const failures: unknown[] = [error];
    if (switched) try { await writeAtomicGitFile(pointerFile, pointer); } catch (failure) { failures.push(failure); }
    if (installed && failures.length === 1) try { await rm(privateStore, { recursive: true }); } catch (failure) { failures.push(failure); }
    try { await rm(temporary, { recursive: true, force: true }); } catch (failure) { failures.push(failure); }
    if (failures.length > 1) throw new AggregateError(failures, "workspace_git_isolation_rollback_failed");
    throw error;
  }
}
