import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { localCommandExecutor, type CommandExecutor } from "../process.ts";
import type { Database } from "../db/client.ts";
import { issueRepositories, issueWorkspaces } from "../db/schema.ts";
import { issueRepositoryWorkspaceNames } from "./git.ts";
import { classifyRepositoryState, issueRuntimeRoot, sharedCheckoutsRoot } from "./state.ts";

const repositoryNamePattern = /^[a-z0-9._-]+$/;

export interface SourceRepository {
  name: string;
  url: string;
  branch: string;
  access: "read" | "write";
}

export interface SourceTreeEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number | null;
}

export interface SourceSearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface SourceCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
}

type SourceCommitFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

export interface SourceCommitFile {
  status: SourceCommitFileStatus;
  path: string;
  previousPath: string | null;
}

export interface SourceBlame {
  path: string;
  line: number;
  commit: string | null;
  shortCommit: string | null;
  author: string;
  date: string | null;
  subject: string;
}

interface SourceRevisionFile {
  path: string;
  revision: string;
  content: string;
}

interface SourceWorkspaceFile {
  path: string;
  version: "index" | "working-tree";
  content: string;
}

type IssueReference = { id: string; key: string };
type RepositoryRow = typeof issueRepositories.$inferSelect;

type SourceContext = {
  repository: RepositoryRow;
  root: string;
  source: SourceRepository;
};

type SourceRevisionContext = {
  source: SourceContext;
  revision: string;
  parent: string | null;
};

function normalizedRelativePath(value: string): string {
  if (value.length > 4096 || value.includes("\0") || path.isAbsolute(value)) throw new Error("invalid_source_path");
  const normalized = path.normalize(value || ".");
  if (normalized === ".") return "";
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) throw new Error("invalid_source_path");
  return normalized;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sourcePath(relative: string): string {
  return relative.split(path.sep).join("/");
}

function missingPathError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) throw new Error("source_path_not_found");
  throw error;
}

export class SourceBrowser {
  private readonly database: Database;
  private readonly stateRoot: string;
  private readonly executor: CommandExecutor;

  constructor(database: Database, stateRoot: string, executor: CommandExecutor = localCommandExecutor) {
    this.database = database;
    this.stateRoot = path.resolve(stateRoot);
    this.executor = executor;
  }

  async repositories(issue: IssueReference): Promise<SourceRepository[]> {
    const rows = await this.repositoryRows(issue);
    const names = issueRepositoryWorkspaceNames(rows);
    const state = classifyRepositoryState(rows);
    return rows.map((repository) => ({
      name: names.get(repository.url)!,
      url: repository.url,
      branch: repository.workingBranch ?? repository.baseBranch,
      access: state === "development_workspace" ? "write" : "read",
    }));
  }

  async tree(issue: IssueReference, repositoryName: string, relativePath = ""): Promise<{ path: string; entries: SourceTreeEntry[]; truncated: boolean }> {
    const context = await this.context(issue, repositoryName);
    const directory = await this.resolvePath(context.root, relativePath);
    const metadata = await stat(directory);
    if (!metadata.isDirectory()) throw new Error("source_path_not_directory");
    const entries = await readdir(directory, { withFileTypes: true });
    const visible = entries.filter((entry) => entry.name !== ".git").sort((left, right) => {
      const leftRank = left.isDirectory() ? 0 : left.isFile() ? 1 : 2;
      const rightRank = right.isDirectory() ? 0 : right.isFile() ? 1 : 2;
      return leftRank - rightRank || left.name.localeCompare(right.name);
    });
    const selected = visible.slice(0, issuePilotConfig.limits.sourceBrowser.directoryEntries);
    const parent = normalizedRelativePath(relativePath);
    const serialized = await Promise.all(selected.map(async (entry): Promise<SourceTreeEntry> => {
      const entryPath = sourcePath(path.join(parent, entry.name));
      if (entry.isDirectory()) return { name: entry.name, path: entryPath, type: "directory", size: null };
      if (entry.isFile()) return { name: entry.name, path: entryPath, type: "file", size: (await lstat(path.join(directory, entry.name))).size };
      if (entry.isSymbolicLink()) return { name: entry.name, path: entryPath, type: "symlink", size: null };
      return { name: entry.name, path: entryPath, type: "other", size: null };
    }));
    return { path: sourcePath(parent), entries: serialized, truncated: visible.length > selected.length };
  }

  async file(issue: IssueReference, repositoryName: string, relativePath: string): Promise<{ path: string; content: string; size: number }> {
    return this.workingFile(await this.context(issue, repositoryName), relativePath);
  }

  async search(issue: IssueReference, repositoryName: string, query: string, options: { caseSensitive?: boolean; wordMatch?: boolean } = {}): Promise<{ matches: SourceSearchMatch[]; truncated: boolean }> {
    const value = query.trim();
    if (!value || value.length > issuePilotConfig.limits.sourceBrowser.searchQueryCharacters || value.includes("\0")) throw new Error("invalid_source_query");
    const context = await this.context(issue, repositoryName);
    const result = await this.executor.execute(issuePilotConfig.runtime.sourceBrowser.searchExecutable, [
      "--json", "--no-config", "--hidden", "--fixed-strings", "--line-number", "--column", "--max-filesize", `${issuePilotConfig.limits.sourceBrowser.fileBytes}`,
      ...(options.caseSensitive === false ? ["--ignore-case"] : []),
      ...(options.wordMatch === true ? ["--word-regexp"] : []),
      "--glob", "!.git", "--glob", "!.git/**", "--", value, ".",
    ], { cwd: context.root, timeout: issuePilotConfig.limits.sourceBrowser.commandMs, maxOutputBytes: issuePilotConfig.limits.sourceBrowser.commandOutputBytes });
    if (result.killed) throw new Error("source_search_timeout");
    if (result.code !== 0 && result.code !== 1) throw new Error("source_search_failed");
    const matches: SourceSearchMatch[] = [];
    let truncated = false;
    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      let event: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: Array<{ start?: number }> } };
      try { event = JSON.parse(line) as typeof event; } catch { throw new Error("invalid_source_search_response"); }
      if (event.type !== "match") continue;
      if (matches.length >= issuePilotConfig.limits.sourceBrowser.searchMatches) { truncated = true; break; }
      const data = event.data;
      const resultPath = data?.path?.text;
      const preview = data?.lines?.text;
      const lineNumber = data?.line_number;
      const column = data?.submatches?.[0]?.start;
      if (!resultPath || typeof preview !== "string" || !Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(column)) throw new Error("invalid_source_search_response");
      const normalized = sourcePath(normalizedRelativePath(resultPath.replace(/^\.\//, "")));
      matches.push({ path: normalized, line: lineNumber!, column: column! + 1, preview: preview.replace(/[\r\n]+$/, "").slice(0, 1000) });
    }
    return { matches, truncated };
  }

  async blame(issue: IssueReference, repositoryName: string, relativePath: string, line: number): Promise<SourceBlame> {
    const context = await this.context(issue, repositoryName);
    const selected = sourcePath(normalizedRelativePath(relativePath));
    if (!selected || !Number.isSafeInteger(line) || line < 1) throw new Error("invalid_source_line");
    await this.resolvePath(context.root, selected);
    const result = await this.executor.execute(issuePilotConfig.runtime.sourceBrowser.gitExecutable, [
      "-C", context.root, "blame", "--line-porcelain", "--root", "-L", `${line},${line}`, "--", selected,
    ], this.commandOptions());
    if (result.killed) throw new Error("source_blame_timeout");
    if (result.code !== 0) throw new Error("source_blame_failed");
    const lines = result.stdout.split("\n");
    const hash = lines[0]?.split(" ")[0] ?? "";
    const author = lines.find((entry) => entry.startsWith("author "))?.slice(7) ?? "";
    const timestamp = Number(lines.find((entry) => entry.startsWith("author-time "))?.slice(12));
    const subject = lines.find((entry) => entry.startsWith("summary "))?.slice(8) ?? "";
    if (!/^[a-f0-9]{40}$/.test(hash) || !author || !Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 8_640_000_000 || !subject) throw new Error("invalid_source_blame_response");
    const committed = !/^0{40}$/.test(hash);
    return {
      path: selected,
      line,
      commit: committed ? hash : null,
      shortCommit: committed ? hash.slice(0, 8) : null,
      author,
      date: committed ? new Date(timestamp * 1000).toISOString() : null,
      subject: committed ? subject : "未提交变更",
    };
  }

  async history(issue: IssueReference, repositoryName: string, relativePath = ""): Promise<{ commits: SourceCommit[]; truncated: boolean }> {
    const context = await this.context(issue, repositoryName);
    const selected = normalizedRelativePath(relativePath);
    if (selected) await this.resolvePath(context.root, selected);
    const result = await this.executor.execute(issuePilotConfig.runtime.sourceBrowser.gitExecutable, [
      "-C", context.root, "log", `-${issuePilotConfig.limits.sourceBrowser.historyCommits + 1}`, "--date=iso-strict", "--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1e", "--", ...(selected ? [selected] : []),
    ], { timeout: issuePilotConfig.limits.sourceBrowser.commandMs, maxOutputBytes: issuePilotConfig.limits.sourceBrowser.commandOutputBytes, environment: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } as Record<string, string> });
    if (result.killed) throw new Error("source_history_timeout");
    if (result.code !== 0) throw new Error("source_history_failed");
    const commits: SourceCommit[] = [];
    for (const rawRecord of result.stdout.split("\x1e")) {
      const record = rawRecord.replace(/^\n+|\n+$/g, "");
      if (!record) continue;
      const fields = record.split("\x1f");
      if (fields.length !== 5) throw new Error("invalid_source_history_response");
      const [hash, parentList, author, date, subject] = fields as [string, string, string, string, string];
      const parents = parentList ? parentList.split(" ") : [];
      if (!/^[a-f0-9]{40}$/.test(hash) || parents.some((parent) => !/^[a-f0-9]{40}$/.test(parent)) || !author || !date || Number.isNaN(Date.parse(date)) || subject.includes("\n")) throw new Error("invalid_source_history_response");
      commits.push({ hash, shortHash: hash.slice(0, 8), parents, author, date, subject });
    }
    const truncated = commits.length > issuePilotConfig.limits.sourceBrowser.historyCommits;
    return { commits: commits.slice(0, issuePilotConfig.limits.sourceBrowser.historyCommits), truncated };
  }

  async commit(issue: IssueReference, repositoryName: string, revision: string, relativePath = ""): Promise<{ files: SourceCommitFile[]; truncated: boolean }> {
    const context = await this.revisionContext(issue, repositoryName, revision);
    const selected = normalizedRelativePath(relativePath);
    if (selected) await this.resolvePath(context.source.root, selected);
    try {
      const files = await this.changedFiles(context, selected);
      const limit = issuePilotConfig.limits.sourceBrowser.changeFiles;
      return { files: files.slice(0, limit), truncated: files.length > limit };
    } catch (error) {
      if (error instanceof Error && error.message === "command_output_too_large") throw new Error("source_commit_too_large");
      throw error;
    }
  }

  async commitFile(issue: IssueReference, repositoryName: string, revision: string, relativePath: string): Promise<{
    file: SourceCommitFile;
    before: SourceRevisionFile | null;
    after: SourceRevisionFile | null;
  }> {
    const context = await this.revisionContext(issue, repositoryName, revision);
    const selected = sourcePath(normalizedRelativePath(relativePath));
    if (!selected) throw new Error("invalid_source_path");
    let files: SourceCommitFile[];
    try { files = await this.changedFiles(context, ""); }
    catch (error) {
      if (error instanceof Error && error.message === "command_output_too_large") throw new Error("source_commit_too_large");
      throw error;
    }
    const file = files.find((candidate) => candidate.path === selected);
    if (!file) throw new Error("source_commit_file_not_found");
    const beforePath = file.previousPath ?? file.path;
    const before = file.status === "added" || !context.parent
      ? null
      : { path: beforePath, revision: context.parent, content: await this.revisionFile(context.source, context.parent, beforePath) };
    const after = file.status === "deleted"
      ? null
      : { path: file.path, revision, content: await this.revisionFile(context.source, revision, file.path) };
    return { file, before, after };
  }

  async diff(issue: IssueReference, repositoryName: string, relativePath = ""): Promise<{ files: SourceCommitFile[]; truncated: boolean }> {
    const context = await this.context(issue, repositoryName);
    const selected = normalizedRelativePath(relativePath);
    try {
      const files = await this.workspaceChangedFiles(context, selected);
      const limit = issuePilotConfig.limits.sourceBrowser.changeFiles;
      return { files: files.slice(0, limit), truncated: files.length > limit };
    } catch (error) {
      if (error instanceof Error && error.message === "command_output_too_large") throw new Error("source_diff_too_large");
      throw error;
    }
  }

  async diffFile(issue: IssueReference, repositoryName: string, relativePath: string): Promise<{
    file: SourceCommitFile;
    before: SourceWorkspaceFile | null;
    after: SourceWorkspaceFile | null;
  }> {
    const context = await this.context(issue, repositoryName);
    const selected = sourcePath(normalizedRelativePath(relativePath));
    if (!selected) throw new Error("invalid_source_path");
    let files: SourceCommitFile[];
    try { files = await this.workspaceChangedFiles(context, ""); }
    catch (error) {
      if (error instanceof Error && error.message === "command_output_too_large") throw new Error("source_diff_too_large");
      throw error;
    }
    const file = files.find((candidate) => candidate.path === selected);
    if (!file) throw new Error("source_diff_file_not_found");
    const beforePath = file.previousPath ?? file.path;
    const before = file.status === "added"
      ? null
      : { path: beforePath, version: "index" as const, content: await this.indexFile(context, beforePath) };
    const after = file.status === "deleted"
      ? null
      : { path: file.path, version: "working-tree" as const, content: (await this.workingFile(context, file.path)).content };
    return { file, before, after };
  }

  private commandOptions(maxOutputBytes = issuePilotConfig.limits.sourceBrowser.commandOutputBytes) {
    return {
      timeout: issuePilotConfig.limits.sourceBrowser.commandMs,
      maxOutputBytes,
      environment: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } as Record<string, string>,
    };
  }

  private async revisionContext(issue: IssueReference, repositoryName: string, revision: string): Promise<SourceRevisionContext> {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("invalid_source_revision");
    const source = await this.context(issue, repositoryName);
    const ancestor = await this.executor.execute(issuePilotConfig.runtime.sourceBrowser.gitExecutable, ["-C", source.root, "merge-base", "--is-ancestor", revision, "HEAD"], this.commandOptions());
    if (ancestor.killed) throw new Error("source_history_timeout");
    if (ancestor.code === 1) throw new Error("source_commit_not_found");
    if (ancestor.code !== 0) throw new Error("source_history_failed");
    const parents = await this.executor.execute(issuePilotConfig.runtime.sourceBrowser.gitExecutable, ["-C", source.root, "rev-list", "--parents", "-n", "1", revision], this.commandOptions());
    if (parents.killed) throw new Error("source_history_timeout");
    if (parents.code !== 0) throw new Error("source_history_failed");
    const hashes = parents.stdout.trim().split(/\s+/);
    if (hashes[0] !== revision || hashes.some((hash) => !/^[a-f0-9]{40}$/.test(hash))) throw new Error("invalid_source_history_response");
    return { source, revision, parent: hashes[1] ?? null };
  }

  private async changedFiles(context: SourceRevisionContext, selected: string): Promise<SourceCommitFile[]> {
    const argumentsBeforeRange = ["-C", context.source.root, context.parent ? "diff" : "diff-tree", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", "-C"];
    const range = context.parent
      ? [context.parent, context.revision]
      : ["--root", "--no-commit-id", "-r", context.revision];
    const result = await this.executor.execute(issuePilotConfig.runtime.sourceBrowser.gitExecutable, [...argumentsBeforeRange, ...range, "--", ...(selected ? [selected] : [])], this.commandOptions());
    if (result.killed) throw new Error("source_history_timeout");
    if (result.code !== 0) throw new Error("source_history_failed");
    return this.parseChangedFiles(result.stdout, "invalid_source_history_response");
  }

  private async workspaceChangedFiles(context: SourceContext, selected: string): Promise<SourceCommitFile[]> {
    const result = await this.executor.execute(issuePilotConfig.runtime.sourceBrowser.gitExecutable, [
      "-C", context.root, "diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", "-C", "--", ...(selected ? [selected] : []),
    ], this.commandOptions());
    if (result.killed) throw new Error("source_diff_timeout");
    if (result.code !== 0) throw new Error("source_diff_failed");
    return this.parseChangedFiles(result.stdout, "invalid_source_diff_response");
  }

  private parseChangedFiles(output: string, invalidResponse: string): SourceCommitFile[] {
    if (!output) return [];
    if (!output.endsWith("\0")) throw new Error(invalidResponse);
    const fields = output.slice(0, -1).split("\0");
    const files: SourceCommitFile[] = [];
    for (let index = 0; index < fields.length;) {
      const rawStatus = fields[index++];
      if (!rawStatus) throw new Error(invalidResponse);
      const rename = /^[RC]\d{1,3}$/.test(rawStatus);
      const rawPreviousPath = rename ? fields[index++] : null;
      const rawPath = fields[index++];
      if (!rawPath || (rename && !rawPreviousPath)) throw new Error(invalidResponse);
      const filePath = sourcePath(normalizedRelativePath(rawPath));
      const previousPath = rawPreviousPath ? sourcePath(normalizedRelativePath(rawPreviousPath)) : null;
      if (!filePath || previousPath === "") throw new Error(invalidResponse);
      let status: SourceCommitFileStatus;
      if (rawStatus === "A") status = "added";
      else if (rawStatus === "D") status = "deleted";
      else if (rawStatus === "M" || rawStatus === "T") status = "modified";
      else if (rawStatus.startsWith("R")) status = "renamed";
      else if (rawStatus.startsWith("C")) status = "copied";
      else throw new Error(invalidResponse);
      files.push({ status, path: filePath, previousPath });
    }
    return files;
  }

  private revisionFile(context: SourceContext, revision: string, relativePath: string): Promise<string> {
    return this.gitFile(context, `${revision}:${relativePath}`, "source_history_timeout", "source_history_failed", "invalid_source_history_response");
  }

  private indexFile(context: SourceContext, relativePath: string): Promise<string> {
    return this.gitFile(context, `:${relativePath}`, "source_diff_timeout", "source_diff_failed", "invalid_source_diff_response");
  }

  private async gitFile(context: SourceContext, object: string, timeoutError: string, commandError: string, invalidResponse: string): Promise<string> {
    const size = await this.executor.execute(issuePilotConfig.runtime.sourceBrowser.gitExecutable, ["-C", context.root, "cat-file", "-s", object], this.commandOptions(4096));
    if (size.killed) throw new Error(timeoutError);
    if (size.code !== 0) throw new Error(commandError);
    const bytes = Number(size.stdout.trim());
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(invalidResponse);
    if (bytes > issuePilotConfig.limits.sourceBrowser.fileBytes) throw new Error("source_file_too_large");
    let result;
    try {
      result = await this.executor.execute(issuePilotConfig.runtime.sourceBrowser.gitExecutable, ["-C", context.root, "cat-file", "blob", object], this.commandOptions(issuePilotConfig.limits.sourceBrowser.fileBytes + 4096));
    } catch (error) {
      if (error instanceof Error && error.message === "command_output_too_large") throw new Error("source_file_too_large");
      throw error;
    }
    if (result.killed) throw new Error(timeoutError);
    if (result.code !== 0) throw new Error(commandError);
    if (result.stdout.includes("\0") || result.stdout.includes("\ufffd")) throw new Error("source_file_binary");
    return result.stdout;
  }

  private async workingFile(context: SourceContext, relativePath: string): Promise<{ path: string; content: string; size: number }> {
    const file = await this.resolvePath(context.root, relativePath);
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new Error("source_path_not_file");
    if (metadata.size > issuePilotConfig.limits.sourceBrowser.fileBytes) throw new Error("source_file_too_large");
    const content = await readFile(file);
    if (content.subarray(0, Math.min(content.length, 8192)).includes(0)) throw new Error("source_file_binary");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); }
    catch { throw new Error("source_file_binary"); }
    return { path: sourcePath(normalizedRelativePath(relativePath)), content: text, size: metadata.size };
  }

  private async repositoryRows(issue: IssueReference): Promise<RepositoryRow[]> {
    const [workspace, repositories] = await Promise.all([
      this.database.select({ runtimeReady: issueWorkspaces.runtimeReady }).from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue.id)).limit(1),
      this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
    ]);
    if (!workspace[0]?.runtimeReady) throw new Error("source_browser_unavailable");
    if (classifyRepositoryState(repositories) === "invalid") throw new Error("source_repository_state_invalid");
    return repositories;
  }

  private async context(issue: IssueReference, repositoryName: string): Promise<SourceContext> {
    if (!repositoryNamePattern.test(repositoryName)) throw new Error("source_repository_not_found");
    const rows = await this.repositoryRows(issue);
    const state = classifyRepositoryState(rows);
    const names = issueRepositoryWorkspaceNames(rows);
    const repository = rows.find((candidate) => names.get(candidate.url) === repositoryName);
    if (!repository) throw new Error("source_repository_not_found");
    const runtimeRepository = path.join(issueRuntimeRoot(this.stateRoot, issue.key), repositoryName);
    let metadata;
    try { metadata = await lstat(runtimeRepository); } catch (error) { missingPathError(error); }
    if (!metadata!.isSymbolicLink()) throw new Error("source_runtime_invalid");
    let root: string;
    try { root = await realpath(runtimeRepository); } catch (error) { missingPathError(error); }
    if (state === "development_workspace") {
      if (!repository.localPath || path.resolve(repository.localPath) !== root) throw new Error("source_runtime_invalid");
    } else {
      const checkoutRoot = sharedCheckoutsRoot(this.stateRoot);
      const relative = path.relative(checkoutRoot, root);
      const segments = relative.split(path.sep);
      if (relative.startsWith("..") || path.isAbsolute(relative) || segments.length !== 2 || !/^[a-f0-9]{40}$/.test(segments[1]!)) throw new Error("source_runtime_invalid");
    }
    return {
      repository,
      root,
      source: { name: repositoryName, url: repository.url, branch: repository.workingBranch ?? repository.baseBranch, access: state === "development_workspace" ? "write" : "read" },
    };
  }

  private async resolvePath(root: string, relativePath: string): Promise<string> {
    const relative = normalizedRelativePath(relativePath);
    const candidate = path.resolve(root, relative);
    if (!isInside(root, candidate)) throw new Error("invalid_source_path");
    let resolved: string;
    try { resolved = await realpath(candidate); } catch (error) { missingPathError(error); }
    if (!isInside(root, resolved)) throw new Error("source_path_outside_repository");
    return resolved;
  }
}
