import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { issueRepositories } from "../db/schema.ts";
import { developmentRepositoryStorePath, repositoryStorePath, WorktreeManager } from "./git.ts";
import { readIssueBranchCommit, validateIssueWorktreeBinding } from "./issue-git.ts";
import { assertIssueRoot, issueRoot, sharedCheckoutsRoot, type RepositoryState } from "./state.ts";

export interface IssueRuntimeRepository {
  name: string;
  repositoryPath: string;
}
export interface RelatedIssueRuntime {
  key: string;
  metadata: Record<string, unknown>;
  conversationPath?: string;
  workDirectory: string;
}
export type IssueRuntimeAccess = "read" | "write";
/** Resolve the recorded code entry without changing the view, branch, or remote refs. */
export async function resolveRecordedRepository(
  stateRoot: string,
  issueKey: string,
  repository: typeof issueRepositories.$inferSelect,
  name: string,
  state: Exclude<RepositoryState, "invalid">,
  checkedCheckouts?: Set<string>,
): Promise<{ root: string; store?: string }> {
  const entry = path.join(await assertIssueRoot(stateRoot, issueKey), entryName(name));
  const metadata = await lstat(entry);
  const development = state === "development_workspace";
  if (development ? !metadata.isDirectory() : !metadata.isSymbolicLink()) throw new Error("source_runtime_invalid");
  const root = await realpath(entry);
  if (development && (!repository.localPath || path.resolve(repository.localPath) !== entry || root !== entry)) throw new Error("source_runtime_invalid");
  try {
    if (development) {
      const store = await developmentRepositoryStorePath(stateRoot, issueKey, repository.url);
      await validateIssueWorktreeBinding(store, root, repository.workingBranch!);
      return { root, store };
    }
    const store = repositoryStorePath(stateRoot, repository.url);
    const parent = path.join(sharedCheckoutsRoot(stateRoot), path.basename(store));
    if (path.dirname(root) !== parent || !/^[a-f0-9]{40}$/.test(path.basename(root))) throw new Error("source_runtime_invalid");
    // commitBefore is the baseline for dev. A released view represents the recorded local working branch.
    const commit = state === "read_only" ? repository.commitBefore : await readIssueBranchCommit(await developmentRepositoryStorePath(stateRoot, issueKey, repository.url), repository.workingBranch!);
    if (path.basename(root) !== commit) throw new Error("source_runtime_invalid");
    await new WorktreeManager(stateRoot).assertSharedCheckout(root, commit, store, checkedCheckouts);
    return { root };
  } catch (error) {
    if (error instanceof Error && error.message === "source_runtime_invalid") throw error;
    throw new Error("source_git_binding_invalid", { cause: error });
  }
}
function managedRepository(stateRoot: string, issueKey: string, repositoryPath: string, access: IssueRuntimeAccess): string {
  const resolved = path.resolve(repositoryPath);
  if (access === "write") {
    if (path.dirname(resolved) !== issueRoot(stateRoot, issueKey)) throw new Error("repository_workspace_outside_issue_root");
    return resolved;
  }
  const relative = path.relative(sharedCheckoutsRoot(stateRoot), resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("repository_checkout_outside_shared_root");
  return resolved;
}
interface RuntimeEntry {
  name: string;
  kind: "link" | "file";
  value: string;
}
const manifestName = ".issue-runtime.json";
const absent = async (selected: string) =>
  lstat(selected).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
function entryName(name: string): string {
  if (!/^[a-z0-9._-]+$/i.test(name) || [".", "..", ".git", manifestName].includes(name.toLowerCase())) throw new Error("invalid_runtime_repository_name");
  return name;
}
async function loadRuntime(root: string): Promise<{ entries: RuntimeEntry[]; modesMatch: boolean } | undefined> {
  const file = path.join(root, manifestName),
    metadata = await absent(file);
  if (!metadata) return undefined;
  if (!metadata.isFile()) throw new Error("invalid_issue_runtime_manifest");
  const data = JSON.parse(await readFile(file, "utf8"));
  if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error("invalid_issue_runtime_manifest");
  const entries = data.entries as RuntimeEntry[];
  if (
    entries.some((entry) => !entry || typeof entry.name !== "string" || !["link", "file"].includes(entry.kind) || typeof entry.value !== "string") ||
    new Set(entries.map((entry) => entry.name)).size !== entries.length
  )
    throw new Error("invalid_issue_runtime_manifest");
  let modesMatch = (metadata.mode & 0o7777) === 0o600;
  for (const entry of entries) {
    entryName(entry.name);
    const selected = path.join(root, entry.name),
      metadata = await absent(selected);
    if (!metadata) throw new Error("issue_runtime_entry_missing");
    if (
      entry.kind === "link"
        ? !metadata.isSymbolicLink() || path.resolve(root, await readlink(selected)) !== entry.value
        : !metadata.isFile() || digest(await readFile(selected, "utf8")) !== entry.value
    )
      throw new Error("issue_runtime_entry_changed");
    if (entry.kind === "file" && (metadata.mode & 0o7777) !== 0o400) modesMatch = false;
  }
  return { entries, modesMatch };
}
/** Released code may retain only the application's recorded links to this repository's immutable cache. */
export async function assertReleasedIssueRuntime(stateRoot: string, issueKey: string, repositories: Array<{ name: string; url: string }>): Promise<void> {
  const root = issueRoot(stateRoot, issueKey),
    metadata = await absent(root);
  // A released Issue keeps its durable content in this root; losing it must never rebuild from the shared refs.
  if (!metadata) throw new Error("workspace_missing");
  if (!metadata.isDirectory() || (await realpath(root)) !== root) throw new Error("workspace_path_already_exists");
  const entries = (await loadRuntime(root))?.entries ?? [];
  for (const repository of repositories) {
    const name = entryName(repository.name),
      selected = await absent(path.join(root, name));
    if (!selected) continue;
    const entry = entries.find((entry) => entry.name === name);
    const cache = path.join(sharedCheckoutsRoot(stateRoot), path.basename(repositoryStorePath(stateRoot, repository.url)));
    if (!selected.isSymbolicLink() || entry?.kind !== "link" || !/^[a-f0-9]{40}$/.test(path.relative(cache, entry.value))) throw new Error("workspace_path_already_exists");
  }
}
/** Generated links and metadata are flat files. Only entries owned by the previous manifest may be replaced. */
export async function prepareIssueRuntime(
  stateRoot: string,
  issueKey: string,
  repositories: IssueRuntimeRepository[],
  access: IssueRuntimeAccess,
  relatedIssues: RelatedIssueRuntime[] = [],
): Promise<string> {
  const root = await assertIssueRoot(stateRoot, issueKey);
  if (((await lstat(root)).mode & 0o7777) !== 0o700) await chmod(root, 0o700);
  const desired: Array<{ name: string; kind: "link" | "file"; content: string }> = [],
    names = new Set<string>();
  const add = (name: string, kind: "link" | "file", content: string) => {
    entryName(name);
    if (names.has(name)) throw new Error("invalid_runtime_repository_name");
    names.add(name);
    desired.push({ name, kind, content });
  };
  for (const repository of repositories) {
    entryName(repository.name);
    if (names.has(repository.name)) throw new Error("invalid_runtime_repository_name");
    const target = managedRepository(stateRoot, issueKey, repository.repositoryPath, access);
    if (access === "write") {
      if (path.join(root, repository.name) !== target || !(await lstat(target)).isDirectory()) throw new Error("repository_workspace_outside_issue_root");
      names.add(repository.name);
    } else add(repository.name, "link", target);
  }
  for (const related of relatedIssues) {
    const key = related.key.toLowerCase();
    if (!/^issue-[0-9]{8}-[0-9]{3,}$/.test(key)) throw new Error("invalid_related_issue_key");
    add(`.related-${key}.json`, "file", JSON.stringify(related.metadata, null, 2) + "\n");
    if (related.conversationPath) {
      const conversation = path.resolve(related.conversationPath);
      if (path.dirname(conversation) !== issueRoot(stateRoot, related.key)) throw new Error("invalid_related_issue_session");
      add(`.related-${key}.jsonl`, "link", conversation);
    }
    const target = issueRoot(stateRoot, related.key);
    if (path.resolve(related.workDirectory) !== target) throw new Error("invalid_related_issue_directory");
    add(`.related-${key}`, "link", target);
  }
  const manifest = await loadRuntime(root);
  const previous = manifest?.entries ?? [];
  const previousByName = new Map(previous.map((entry) => [entry.name, entry]));
  const entries: RuntimeEntry[] = desired.map(({ name, kind, content }) => ({ name, kind, value: kind === "link" ? content : digest(content) }));
  for (const entry of entries) if (!previousByName.has(entry.name) && (await absent(path.join(root, entry.name)))) throw new Error("issue_runtime_path_collision");
  if (
    manifest?.modesMatch &&
    previous.length === entries.length &&
    entries.every(({ name, kind, value }) => {
      const entry = previousByName.get(name);
      return entry?.kind === kind && entry.value === value;
    })
  )
    return root;
  const operation = randomUUID(),
    backups: Array<{ original: string; backup: string }> = [],
    installed: string[] = [],
    staged: string[] = [];
  let committed = false,
    failed = false,
    failure: unknown,
    result: string | undefined;
  try {
    for (const entry of desired) {
      const temporary = path.join(root, `.runtime-${operation}-${staged.length}`);
      staged.push(temporary);
      if (entry.kind === "link") await symlink(path.relative(root, entry.content), temporary);
      else await writeFile(temporary, entry.content, { mode: 0o400, flag: "wx" });
    }
    for (const entry of previous) {
      const original = path.join(root, entry.name),
        backup = path.join(root, `.runtime-old-${operation}-${backups.length}`);
      await rename(original, backup);
      backups.push({ original, backup });
    }
    for (let index = 0; index < desired.length; index++) {
      const target = path.join(root, desired[index]!.name);
      await link(staged[index]!, target);
      installed.push(target);
      await rm(staged[index]!);
    }
    const manifest = path.join(root, `.runtime-manifest-${operation}`);
    staged.push(manifest);
    await writeFile(manifest, JSON.stringify({ version: 1, entries }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(manifest, path.join(root, manifestName));
    committed = true;
    for (const entry of backups) await rm(entry.backup);
    result = root;
  } catch (error) {
    failed = true;
    if (committed) failure = new Error("issue_runtime_finalize_failed", { cause: error });
    else {
      const failures: unknown[] = [];
      for (const target of installed.reverse())
        try {
          await rm(target);
        } catch (caught) {
          failures.push(caught);
        }
      for (const entry of backups.reverse())
        try {
          await rename(entry.backup, entry.original);
        } catch (caught) {
          failures.push(caught);
        }
      failure = failures.length ? new AggregateError([error, ...failures], "issue_runtime_rollback_failed") : error;
    }
  }
  // Cleanup failures must not replace the original media outcome; keep both as diagnostics.
  const cleanupFailures: unknown[] = [];
  for (const temporary of staged)
    try {
      await rm(temporary, { force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
  if (failed) {
    if (cleanupFailures.length) throw new AggregateError([failure, ...cleanupFailures], "issue_runtime_cleanup_failed");
    throw failure;
  }
  if (cleanupFailures.length) throw new Error("issue_runtime_finalize_failed", { cause: new AggregateError(cleanupFailures, "issue_runtime_finalize_failed") });
  return result!;
}
