import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import pMap from "p-map";
import type { Database } from "../db/client.ts";
import { issueWorkspaces } from "../db/schema.ts";
import { errorMessage } from "../domain/contracts.ts";
import { repositoryStorePath } from "./git.ts";
import { issueRoot, sharedCheckoutsRoot } from "./state.ts";

export interface IssueRuntimeRepository { name: string; repositoryPath: string }
export interface RelatedIssueRuntime { key: string; metadata: Record<string, unknown>; conversationPath?: string; workDirectory: string }
export type IssueRuntimeAccess = "read" | "write";
export interface RuntimePreparationResult { prepared: string[]; blocked: Array<{ issueKey: string; reason: string }> }
export async function prepareIssueRuntimeBatch<T extends { id: string; key: string }>(database: Database, issueRows: T[], prepareRuntime: (issue: T) => Promise<unknown>, options: { concurrency?: number } = {}): Promise<RuntimePreparationResult> {
  const outcomes = await pMap(issueRows, async issue => {
    try { await prepareRuntime(issue); return { issueKey: issue.key }; }
    catch (error) { await database.update(issueWorkspaces).set({ runtimeReady: false, updatedAt: new Date() }).where(and(eq(issueWorkspaces.issueId, issue.id), eq(issueWorkspaces.runtimeReady, true))).catch(() => undefined); return { issueKey: issue.key, reason: errorMessage(error) }; }
  }, { concurrency: options.concurrency ?? 1, stopOnError: false });
  return { prepared: outcomes.filter(row => row.reason === undefined).map(row => row.issueKey), blocked: outcomes.filter((row): row is { issueKey: string; reason: string } => row.reason !== undefined) };
}
function managedRepository(stateRoot: string, issueKey: string, repositoryPath: string, access: IssueRuntimeAccess): string {
  const resolved = path.resolve(repositoryPath);
  if (access === "write") { if (path.dirname(resolved) !== issueRoot(stateRoot, issueKey)) throw new Error("repository_workspace_outside_issue_root"); return resolved; }
  const relative = path.relative(sharedCheckoutsRoot(stateRoot), resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("repository_checkout_outside_shared_root");
  return resolved;
}
interface RuntimeEntry { name: string; kind: "link" | "file"; value: string }
const manifestName = ".issue-runtime.json";
const absent = async (selected: string) => lstat(selected).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
function entryName(name: string): string {
  if (!/^[a-z0-9._-]+$/i.test(name) || [".", "..", ".git", manifestName].includes(name.toLowerCase())) throw new Error("invalid_runtime_repository_name");
  return name;
}
async function loadRuntime(root: string): Promise<RuntimeEntry[]> {
  const file = path.join(root, manifestName), metadata = await absent(file);
  if (!metadata) return [];
  if (!metadata.isFile()) throw new Error("invalid_issue_runtime_manifest");
  const data = JSON.parse(await readFile(file, "utf8"));
  if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error("invalid_issue_runtime_manifest");
  const entries = data.entries as RuntimeEntry[];
  if (entries.some(entry => !entry || typeof entry.name !== "string" || !["link", "file"].includes(entry.kind) || typeof entry.value !== "string") || new Set(entries.map(entry => entry.name)).size !== entries.length) throw new Error("invalid_issue_runtime_manifest");
  for (const entry of entries) {
    entryName(entry.name);
    const selected = path.join(root, entry.name), metadata = await absent(selected);
    if (!metadata) throw new Error("issue_runtime_entry_missing");
    if (entry.kind === "link" ? !metadata.isSymbolicLink() || path.resolve(root, await readlink(selected)) !== entry.value : !metadata.isFile() || digest(await readFile(selected, "utf8")) !== entry.value) throw new Error("issue_runtime_entry_changed");
  }
  return entries;
}
/** Released code may retain only the application's recorded links to this repository's immutable cache. */
export async function assertReleasedIssueRuntime(stateRoot: string, issueKey: string, repositories: Array<{ name: string; url: string }>): Promise<void> {
  const root = issueRoot(stateRoot, issueKey), metadata = await absent(root);
  if (!metadata) return;
  if (!metadata.isDirectory() || await realpath(root) !== root) throw new Error("workspace_path_already_exists");
  const entries = await loadRuntime(root);
  for (const repository of repositories) {
    const name = entryName(repository.name), selected = await absent(path.join(root, name));
    if (!selected) continue;
    const entry = entries.find(entry => entry.name === name);
    const cache = path.join(sharedCheckoutsRoot(stateRoot), path.basename(repositoryStorePath(stateRoot, repository.url)));
    if (!selected.isSymbolicLink() || entry?.kind !== "link" || !/^[a-f0-9]{40}$/.test(path.relative(cache, entry.value))) throw new Error("workspace_path_already_exists");
  }
}
/** Generated links and metadata are flat files. Only entries owned by the previous manifest may be replaced. */
export async function prepareIssueRuntime(stateRoot: string, issueKey: string, repositories: IssueRuntimeRepository[], access: IssueRuntimeAccess, relatedIssues: RelatedIssueRuntime[] = []): Promise<string> {
  const root = issueRoot(stateRoot, issueKey);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error("invalid_issue_runtime_root");
  await chmod(root, 0o700);
  const desired: Array<{ name: string; kind: "link" | "file"; content: string }> = [], names = new Set<string>();
  const add = (name: string, kind: "link" | "file", content: string) => { entryName(name); if (names.has(name)) throw new Error("invalid_runtime_repository_name"); names.add(name); desired.push({ name, kind, content }); };
  for (const repository of repositories) {
    entryName(repository.name); if (names.has(repository.name)) throw new Error("invalid_runtime_repository_name");
    const target = managedRepository(stateRoot, issueKey, repository.repositoryPath, access);
    if (access === "write") { if (path.join(root, repository.name) !== target || !(await lstat(target)).isDirectory()) throw new Error("repository_workspace_outside_issue_root"); names.add(repository.name); }
    else add(repository.name, "link", target);
  }
  for (const related of relatedIssues) {
    const key = related.key.toLowerCase(); if (!/^issue-[0-9]{8}-[0-9]{3,}$/.test(key)) throw new Error("invalid_related_issue_key");
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
  const previous = await loadRuntime(root), previousNames = new Set(previous.map(entry => entry.name));
  for (const entry of desired) if (!previousNames.has(entry.name) && await absent(path.join(root, entry.name))) throw new Error("issue_runtime_path_collision");
  const operation = randomUUID(), backups: Array<{ original: string; backup: string }> = [], installed: string[] = [], staged: string[] = [];
  let committed = false;
  try {
    const entries: RuntimeEntry[] = [];
    for (const entry of desired) {
      const temporary = path.join(root, `.runtime-${operation}-${staged.length}`); staged.push(temporary);
      if (entry.kind === "link") await symlink(path.relative(root, entry.content), temporary);
      else await writeFile(temporary, entry.content, { mode: 0o400, flag: "wx" });
      entries.push({ name: entry.name, kind: entry.kind, value: entry.kind === "link" ? entry.content : digest(entry.content) });
    }
    for (const entry of previous) {
      const original = path.join(root, entry.name), backup = path.join(root, `.runtime-old-${operation}-${backups.length}`);
      await rename(original, backup); backups.push({ original, backup });
    }
    for (let index = 0; index < desired.length; index++) {
      const target = path.join(root, desired[index]!.name);
      await link(staged[index]!, target); installed.push(target); await rm(staged[index]!);
    }
    const manifest = path.join(root, `.runtime-manifest-${operation}`); staged.push(manifest);
    await writeFile(manifest, JSON.stringify({ version: 1, entries }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(manifest, path.join(root, manifestName)); committed = true;
    for (const entry of backups) await rm(entry.backup);
    return root;
  } catch (error) {
    if (committed) throw new Error("issue_runtime_finalize_failed", { cause: error });
    const failures: unknown[] = [];
    for (const target of installed.reverse()) try { await rm(target); } catch (failure) { failures.push(failure); }
    for (const entry of backups.reverse()) try { await rename(entry.backup, entry.original); } catch (failure) { failures.push(failure); }
    if (failures.length) throw new AggregateError([error, ...failures], "issue_runtime_rollback_failed");
    throw error;
  } finally { for (const temporary of staged) await rm(temporary, { force: true }); }
}
