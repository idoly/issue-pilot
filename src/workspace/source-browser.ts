import { OperationError } from "../operation-error.ts";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { localCommandExecutor, type CommandExecutor } from "../process.ts";
import type { Database } from "../db/client.ts";
import { issueRepositories, issueWorkspaces } from "../db/schema.ts";
import { issueRepositoryWorkspaceNames } from "./git.ts";
import { resolveRecordedRepository } from "./runtime.ts";
import type { WorkFileRepository } from "./work-files.ts";
import { classifyRepositoryState, issueRoot } from "./state.ts";

import type {
  SourceBlame,
  SourceChanges,
  SourceCommit,
  SourceCommitFile,
  SourceCommitFileComparison,
  SourceFile,
  SourceHistoryCursor,
  SourceHistoryPage,
  SourceRepository,
  SourceSearchMatch,
  SourceTree,
  SourceTreeEntry,
  SourceWorkspaceFileComparison,
} from "./source-contracts.ts";

const repositoryNamePattern = /^[a-z0-9._-]+$/;

type IssueReference = { id: string; key: string };
type SourceContext = {
  root: string;
  workingBranch: string | null;
  /** Validated isolated store of a development workspace; writes reuse it instead of rescanning. */
  store?: string;
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
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized) || normalized.split(path.sep).includes(".git")) throw new Error("invalid_source_path");
  return normalized;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sourcePath(relative: string): string {
  return relative.split(path.sep).join("/");
}

function missingPathError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) throw new Error("source_path_not_found");
  throw error;
}

/** Filesystem mutation failures use the same stable codes as validation, never raw errno messages. */
function mutationPathError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (code === "ENOENT" || code === "ENOTDIR") throw new Error("source_path_not_found");
    // Node's fs.rm reports directory/non-empty failures as ERR_FS_*; other runtimes use the errno names.
    if (code === "ENOTEMPTY" || code === "EISDIR" || code === "ERR_FS_ENOTEMPTY" || code === "ERR_FS_EISDIR") throw new Error("source_path_not_empty");
    if (code === "EEXIST") throw new Error("source_path_exists");
  }
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
    const { rows, state } = await this.repositorySet(issue);
    const names = issueRepositoryWorkspaceNames(rows);
    return rows.map((repository) => ({
      name: names.get(repository.url)!,
      url: repository.url,
      branch: repository.workingBranch ?? repository.baseBranch,
      access: state === "development_workspace" ? "write" : "read",
    }));
  }

  async workFileRepositories(issue: IssueReference): Promise<Map<string, WorkFileRepository>> {
    const recorded = await this.repositorySet(issue).catch((error: unknown) => {
      if (error instanceof Error && ["source_browser_unavailable", "source_repository_state_invalid"].includes(error.message)) return undefined;
      throw error;
    });
    const roots = new Map<string, WorkFileRepository>();
    if (!recorded) return roots;
    const { rows, state } = recorded;
    const names = issueRepositoryWorkspaceNames(rows);
    const root = issueRoot(this.stateRoot, issue.key);
    for (const repository of rows) {
      const name = names.get(repository.url)!;
      roots.set(name, {
        entry: path.join(root, name),
        resolve: async () => (await resolveRecordedRepository(this.stateRoot, issue.key, repository, name, state).catch(missingPathError)).root,
      });
    }
    return roots;
  }

  async tree(issue: IssueReference, repositoryName: string, relativePath = ""): Promise<SourceTree> {
    const context = await this.context(issue, repositoryName);
    const directory = await this.resolvePath(context.root, relativePath);
    const metadata = await stat(directory);
    if (!metadata.isDirectory()) throw new Error("source_path_not_directory");
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const pinned = `/proc/self/fd/${handle.fd}`;
      if ((await realpath(pinned)) !== directory) throw new Error("source_path_outside_repository");
      const entries = await readdir(pinned, { withFileTypes: true });
      const visible = entries
        .filter((entry) => entry.name !== ".git")
        .sort((left, right) => {
          const leftRank = left.isDirectory() ? 0 : left.isFile() ? 1 : 2;
          const rightRank = right.isDirectory() ? 0 : right.isFile() ? 1 : 2;
          return leftRank - rightRank || left.name.localeCompare(right.name);
        });
      const selected = visible.slice(0, issuePilotConfig.limits.sourceBrowser.directoryEntries);
      const parent = normalizedRelativePath(relativePath);
      const results = await Promise.allSettled(
        selected.map(async (entry): Promise<SourceTreeEntry> => {
          const entryPath = sourcePath(path.join(parent, entry.name));
          if (entry.isDirectory()) return { name: entry.name, path: entryPath, type: "directory", size: null };
          if (entry.isFile()) return { name: entry.name, path: entryPath, type: "file", size: (await lstat(path.join(pinned, entry.name))).size };
          if (entry.isSymbolicLink()) return { name: entry.name, path: entryPath, type: "symlink", size: null };
          return { name: entry.name, path: entryPath, type: "other", size: null };
        }),
      );
      const serialized = results.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      return { path: sourcePath(parent), entries: serialized, truncated: visible.length > selected.length };
    } finally {
      await handle.close();
    }
  }

  async file(issue: IssueReference, repositoryName: string, relativePath: string): Promise<SourceFile> {
    return this.workingFile(await this.context(issue, repositoryName), relativePath);
  }

  async writeFile(issue: IssueReference, repositoryName: string, relativePath: string, content: string, expectedSha256: string): Promise<SourceFile> {
    const context = await this.writableContext(issue, repositoryName);
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("invalid_source_hash");
    const selected = normalizedRelativePath(relativePath);
    if (!selected) throw new Error("source_path_not_file");
    return this.withMutablePath(context, selected, true, async (candidate) => {
      let metadata;
      try {
        metadata = await lstat(candidate);
      } catch (error) {
        missingPathError(error);
      }
      if (!metadata!.isFile()) throw new Error("source_path_not_file");
      const currentFile = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let current: Buffer;
      try {
        const currentMetadata = await currentFile.stat();
        if (!currentMetadata.isFile()) throw new Error("source_path_not_file");
        if (currentMetadata.size > issuePilotConfig.limits.sourceBrowser.fileBytes) throw new Error("source_file_too_large");
        current = await currentFile.readFile();
      } finally {
        await currentFile.close();
      }
      if (createHash("sha256").update(current).digest("hex") !== expectedSha256) throw new Error("source_file_changed");
      const next = Buffer.from(content, "utf8");
      if (next.byteLength > issuePilotConfig.limits.sourceBrowser.fileBytes) throw new Error("source_file_too_large");
      const temporary = path.join(path.dirname(candidate), `.issue-pilot-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", metadata!.mode & 0o777);
      const failures: unknown[] = [];
      let published = false;
      try {
        await handle.writeFile(next);
        await handle.close();
        await rename(temporary, candidate);
        published = true;
      } catch (error) {
        failures.push(error);
        throw error;
      } finally {
        const cleanup: unknown[] = [];
        try {
          await handle.close();
        } catch (error) {
          cleanup.push(error);
        }
        if (!published)
          try {
            await rm(temporary, { force: true });
          } catch (error) {
            cleanup.push(error);
          }
        // biome-ignore lint/correctness/noUnsafeFinally: the cleanup failure is aggregated with the in-flight primary error, so no diagnostic is lost.
        if (cleanup.length) throw new OperationError("source_save_cleanup_failed", published ? "committed" : "not_committed", { cause: new AggregateError([...failures, ...cleanup]) });
      }
      return this.workingFile(context, selected);
    });
  }

  async createFile(issue: IssueReference, repositoryName: string, relativePath: string, content: string): Promise<SourceFile> {
    const context = await this.writableContext(issue, repositoryName);
    return this.withMutablePath(context, relativePath, false, async (candidate) => {
      const next = Buffer.from(content, "utf8");
      if (next.byteLength > issuePilotConfig.limits.sourceBrowser.fileBytes) throw new Error("source_file_too_large");
      const temporary = path.join(path.dirname(candidate), `.issue-pilot-${randomUUID()}.tmp`);
      // An exclusive open owns only this temporary file; a collision must not delete another operation's file.
      const handle = await open(temporary, "wx", 0o644);
      const failures: unknown[] = [];
      try {
        await writeFile(handle, next);
        await handle.close();
        // Publish complete bytes without replacing a destination created after the earlier absence check.
        try {
          await link(temporary, candidate);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new Error("source_path_exists");
          throw error;
        }
      } catch (error) {
        failures.push(error);
        throw error;
      } finally {
        const cleanup: unknown[] = [];
        try {
          await handle.close();
        } catch (error) {
          cleanup.push(error);
        }
        try {
          await rm(temporary, { force: true });
        } catch (error) {
          cleanup.push(error);
        }
        // biome-ignore lint/correctness/noUnsafeFinally: the cleanup failure is aggregated with the in-flight primary error, so no diagnostic is lost.
        if (cleanup.length) throw new OperationError("source_create_cleanup_failed", failures.length ? "unknown" : "committed", { cause: new AggregateError([...failures, ...cleanup]) });
      }
      return this.workingFile(context, relativePath);
    });
  }

  async createDirectory(issue: IssueReference, repositoryName: string, relativePath: string): Promise<void> {
    const context = await this.writableContext(issue, repositoryName);
    await this.withMutablePath(context, relativePath, false, async (candidate) => {
      try {
        await mkdir(candidate);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new Error("source_path_exists");
        throw error;
      }
    });
  }

  async deletePath(issue: IssueReference, repositoryName: string, relativePath: string, recursive: boolean): Promise<void> {
    const context = await this.writableContext(issue, repositoryName);
    await this.withMutablePath(context, relativePath, true, async (candidate) => {
      try {
        await rm(candidate, { recursive, force: false });
      } catch (error) {
        mutationPathError(error);
      }
    });
  }

  async renamePath(issue: IssueReference, repositoryName: string, relativePath: string, destinationPath: string, overwrite: boolean): Promise<void> {
    const context = await this.writableContext(issue, repositoryName);
    const selectedSource = path.resolve(context.root, normalizedRelativePath(relativePath));
    const selectedDestination = path.resolve(context.root, normalizedRelativePath(destinationPath));
    if (selectedSource === selectedDestination) {
      await this.withMutablePath(context, relativePath, true, async (source) => {
        try {
          await lstat(source);
        } catch (error) {
          missingPathError(error);
        }
      });
      return;
    }
    if (isInside(selectedSource, selectedDestination) || isInside(selectedDestination, selectedSource)) throw new Error("invalid_source_path");
    await this.withMutablePath(context, relativePath, true, async (source) => {
      let sourceMetadata;
      try {
        sourceMetadata = await lstat(source);
      } catch (error) {
        mutationPathError(error);
      }
      await this.withMutablePath(context, destinationPath, overwrite, async (destination) => {
        const targetMetadata = overwrite
          ? await lstat(destination).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return undefined;
            })
          : undefined;
        // Ordinary files have an atomic replacement primitive. Directory replacement retains
        // its existing semantics below, including replacement of nonempty directories.
        if (!overwrite || !targetMetadata || (sourceMetadata!.isFile() && targetMetadata.isFile())) {
          try {
            await rename(source, destination);
          } catch (error) {
            mutationPathError(error);
          }
          return;
        }
        let previous: string | undefined;
        const backup = path.join(path.dirname(destination), `.issue-pilot-rename-${randomUUID()}.previous`);
        try {
          await rename(destination, backup);
          previous = backup;
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        }
        try {
          await rename(source, destination);
        } catch (error) {
          if (previous) {
            try {
              await rename(previous, destination);
            } catch (rollbackError) {
              throw new OperationError("source_rename_rollback_failed", "unknown", { cause: new AggregateError([error, rollbackError], "source_rename_rollback_failed") });
            }
          }
          mutationPathError(error);
        }
        if (previous) {
          try {
            await rm(previous, { recursive: true, force: true });
          } catch (error) {
            throw new OperationError("source_rename_finalize_failed", "committed", { cause: error });
          }
        }
      });
    });
  }

  async stage(issue: IssueReference, repositoryName: string, paths: string[]): Promise<void> {
    const context = await this.writableContext(issue, repositoryName);
    await this.gitMutation(context, ["add", "-A", "--", ...this.mutablePaths(paths)], "source_stage_failed");
  }

  async unstage(issue: IssueReference, repositoryName: string, paths: string[]): Promise<void> {
    const context = await this.writableContext(issue, repositoryName);
    await this.gitMutation(context, ["reset", "-q", "HEAD", "--", ...this.mutablePaths(paths)], "source_unstage_failed");
  }

  async discard(issue: IssueReference, repositoryName: string, paths: string[]): Promise<void> {
    const context = await this.writableContext(issue, repositoryName);
    const selected = this.mutablePaths(paths);
    const tracked = await this.executor.execute(issuePilotConfig.runtime.sourceBrowser.gitExecutable, ["-C", context.root, "ls-files", "-z", "--", ...selected], this.mutationOptions());
    if (tracked.killed) throw new Error("source_discard_timeout");
    if (tracked.code !== 0) throw new Error("source_discard_failed");
    const trackedPaths = tracked.stdout.split("\0").filter(Boolean);
    if (trackedPaths.length) await this.gitMutation(context, ["checkout", "--", ...trackedPaths], "source_discard_failed");
    await this.gitMutation(context, ["clean", "-fd", "--", ...selected], "source_discard_failed");
  }

  async createCommit(issue: IssueReference, repositoryName: string, message: string, author: { name: string; email: string }): Promise<void> {
    const value = message.trim();
    if (!value || value.length > 4000 || value.includes("\0")) throw new Error("invalid_source_commit_message");
    if (!author.name.trim() || !author.email.trim() || /[\x00-\x1f\x7f]/.test(author.name) || /[\x00-\x1f\x7f]/.test(author.email)) throw new Error("invalid_source_commit_author");
    const context = await this.writableContext(issue, repositoryName);
    await this.gitMutation(context, ["-c", `user.name=${author.name.trim()}`, "-c", `user.email=${author.email.trim()}`, "commit", "-m", value], "source_commit_failed");
  }

  async search(
    issue: IssueReference,
    repositoryName: string,
    query: string,
    options: { caseSensitive?: boolean; wordMatch?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ matches: SourceSearchMatch[]; truncated: boolean }> {
    const value = query.trim();
    if (!value || value.length > issuePilotConfig.limits.sourceBrowser.searchQueryCharacters || value.includes("\0")) throw new Error("invalid_source_query");
    options.signal?.throwIfAborted();
    const context = await this.context(issue, repositoryName);
    const cutoff = new AbortController(),
      signal = options.signal ? AbortSignal.any([cutoff.signal, options.signal]) : cutoff.signal;
    const matches: SourceSearchMatch[] = [];
    let pending = "",
      truncated = false;
    const parseLine = (line: string) => {
      if (!line || truncated) return;
      let event: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: Array<{ start?: number }> } };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        throw new Error("invalid_source_search_response");
      }
      if (event.type !== "match") return;
      if (matches.length === issuePilotConfig.limits.sourceBrowser.searchMatches) {
        truncated = true;
        cutoff.abort();
        return;
      }
      const data = event.data;
      const resultPath = data?.path?.text,
        preview = data?.lines?.text,
        lineNumber = data?.line_number,
        column = data?.submatches?.[0]?.start;
      if (!resultPath || typeof preview !== "string" || !Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(column)) throw new Error("invalid_source_search_response");
      const normalized = sourcePath(normalizedRelativePath(resultPath.replace(/^\.\//, "")));
      matches.push({ path: normalized, line: lineNumber!, column: Buffer.from(preview).subarray(0, column!).toString("utf8").length + 1, preview: preview.replace(/[\r\n]+$/, "").slice(0, 1000) });
    };
    const consume = (chunk: string) => {
      if (truncated) return;
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0 && !truncated) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        parseLine(line);
      }
      if (truncated) pending = "";
    };
    try {
      const result = await this.executor.execute(
        issuePilotConfig.runtime.sourceBrowser.searchExecutable,
        [
          "--json",
          "--no-config",
          "--hidden",
          "--fixed-strings",
          "--line-number",
          "--column",
          "--max-columns",
          "1000",
          "--max-columns-preview",
          ...(options.caseSensitive === false ? ["--ignore-case"] : []),
          ...(options.wordMatch === true ? ["--word-regexp"] : []),
          "--glob",
          "!.git",
          "--glob",
          "!.git/**",
          "--",
          value,
          ".",
        ],
        { cwd: context.root, timeout: issuePilotConfig.limits.sourceBrowser.commandMs, maxOutputBytes: issuePilotConfig.limits.sourceBrowser.commandOutputBytes, signal, onStdout: consume },
      );
      options.signal?.throwIfAborted();
      if (result.stdout) consume(result.stdout);
      if (!truncated && pending) parseLine(pending);
      if (!truncated && result.killed) throw new Error("source_search_timeout");
      if (!truncated && result.code !== 0 && result.code !== 1) throw new Error("source_search_failed");
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!(error instanceof Error) || error.message !== "command_output_too_large") throw error;
      truncated = true;
    }
    return { matches, truncated };
  }

  async blame(issue: IssueReference, repositoryName: string, relativePath: string, line: number): Promise<SourceBlame> {
    const context = await this.context(issue, repositoryName);
    const selected = sourcePath(normalizedRelativePath(relativePath));
    if (!selected || !Number.isSafeInteger(line) || line < 1) throw new Error("invalid_source_line");
    const { content } = await this.workingFile(context, selected);
    const lineCount = content.split("\n").length;
    if (line > lineCount) throw new Error("invalid_source_line");
    const withoutCommit = (subject: string): SourceBlame => ({ path: selected, line, commit: null, shortCommit: null, author: "", date: null, subject });
    if (!content || (content.endsWith("\n") && line === lineCount)) return withoutCommit(content ? "文件末尾" : "空文件");
    const result = await this.executor.execute(
      issuePilotConfig.runtime.sourceBrowser.gitExecutable,
      ["-C", context.root, "blame", "--line-porcelain", "--root", "-L", `${line},${line}`, "--", selected],
      this.commandOptions(),
    );
    if (result.killed) throw new Error("source_blame_timeout");
    if (result.code !== 0) {
      const tracked = await this.executor.execute(issuePilotConfig.runtime.sourceBrowser.gitExecutable, ["-C", context.root, "ls-files", "--error-unmatch", "--", selected], this.commandOptions());
      if (!tracked.killed && tracked.code === 1) return withoutCommit("未提交变更");
      throw new Error("source_blame_failed");
    }
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

  async history(issue: IssueReference, repositoryName: string, relativePath = "", cursor?: SourceHistoryCursor, signal?: AbortSignal): Promise<SourceHistoryPage> {
    if (cursor && (!/^[a-f0-9]{40}$/.test(cursor.revision) || !Number.isSafeInteger(cursor.offset) || cursor.offset <= 0)) throw new Error("invalid_source_history_cursor");
    signal?.throwIfAborted();
    const context = cursor ? (await this.revisionContext(issue, repositoryName, cursor.revision)).source : await this.context(issue, repositoryName);
    const selected = normalizedRelativePath(relativePath);
    let revision = cursor?.revision;
    if (!revision) {
      const head = await this.executor.execute(issuePilotConfig.runtime.sourceBrowser.gitExecutable, ["-C", context.root, "rev-parse", "--verify", "HEAD"], {
        ...this.commandOptions(),
        ...(signal ? { signal } : {}),
      });
      if (head.killed) throw new Error("source_history_timeout");
      if (head.code !== 0) throw new Error("source_history_failed");
      revision = head.stdout.trim();
      if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("invalid_source_history_response");
    }
    const offset = cursor?.offset ?? 0;
    const result = await this.executor.execute(
      issuePilotConfig.runtime.sourceBrowser.gitExecutable,
      [
        "-C",
        context.root,
        "log",
        `-${issuePilotConfig.limits.sourceBrowser.historyCommits + 1}`,
        `--skip=${offset}`,
        "--date=iso-strict",
        "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00",
        revision,
        "--",
        ...(selected ? [selected] : []),
      ],
      { ...this.commandOptions(), ...(signal ? { signal } : {}) },
    );
    if (result.killed) throw new Error("source_history_timeout");
    if (result.code !== 0) throw new Error("source_history_failed");
    const commits: SourceCommit[] = [];
    // NUL separates fields because Git rejects NUL in commit messages and identities; a record ends with its trailing NUL plus the newline Git adds.
    for (const rawRecord of result.stdout.split("\n")) {
      if (!rawRecord) continue;
      const fields = rawRecord.split("\0");
      if (fields.length !== 6 || fields[5] !== "") throw new Error("invalid_source_history_response");
      const [hash, parentList, author, date, subject] = fields as [string, string, string, string, string, string];
      const parents = parentList ? parentList.split(" ") : [];
      if (!/^[a-f0-9]{40}$/.test(hash) || parents.some((parent) => !/^[a-f0-9]{40}$/.test(parent)) || !author || !date || Number.isNaN(Date.parse(date)) || subject.includes("\n"))
        throw new Error("invalid_source_history_response");
      commits.push({ hash, shortHash: hash.slice(0, 8), parents, author, date, subject });
    }
    const truncated = commits.length > issuePilotConfig.limits.sourceBrowser.historyCommits;
    const page = commits.slice(0, issuePilotConfig.limits.sourceBrowser.historyCommits);
    return { commits: page, truncated, nextCursor: truncated ? { revision, offset: offset + page.length } : null };
  }

  async commit(issue: IssueReference, repositoryName: string, revision: string, relativePath = ""): Promise<SourceChanges> {
    const context = await this.revisionContext(issue, repositoryName, revision);
    const selected = normalizedRelativePath(relativePath);
    try {
      const files = await this.changedFiles(context, selected);
      const limit = issuePilotConfig.limits.sourceBrowser.changeFiles;
      return { files: files.slice(0, limit), truncated: files.length > limit };
    } catch (error) {
      if (error instanceof Error && error.message === "command_output_too_large") throw new Error("source_commit_too_large");
      throw error;
    }
  }

  async commitFile(issue: IssueReference, repositoryName: string, revision: string, relativePath: string): Promise<SourceCommitFileComparison> {
    const context = await this.revisionContext(issue, repositoryName, revision);
    const selected = sourcePath(normalizedRelativePath(relativePath));
    if (!selected) throw new Error("invalid_source_path");
    let files: SourceCommitFile[];
    try {
      files = await this.changedFiles(context, "");
    } catch (error) {
      if (error instanceof Error && error.message === "command_output_too_large") throw new Error("source_commit_too_large");
      throw error;
    }
    const file = files.find((candidate) => candidate.path === selected);
    if (!file) throw new Error("source_commit_file_not_found");
    const beforePath = file.previousPath ?? file.path;
    const before = file.status === "added" || !context.parent ? null : { path: beforePath, revision: context.parent, content: await this.revisionFile(context.source, context.parent, beforePath) };
    const after = file.status === "deleted" ? null : { path: file.path, revision, content: await this.revisionFile(context.source, revision, file.path) };
    return { file, before, after };
  }

  async diff(issue: IssueReference, repositoryName: string, relativePath = "", staged = false): Promise<SourceChanges> {
    const context = await this.context(issue, repositoryName);
    const selected = normalizedRelativePath(relativePath);
    try {
      const files = await this.workspaceChangedFiles(context, selected, staged);
      const limit = issuePilotConfig.limits.sourceBrowser.changeFiles;
      return { files: files.slice(0, limit), truncated: files.length > limit };
    } catch (error) {
      if (error instanceof Error && error.message === "command_output_too_large") throw new Error("source_diff_too_large");
      throw error;
    }
  }

  async diffFile(issue: IssueReference, repositoryName: string, relativePath: string, staged = false): Promise<SourceWorkspaceFileComparison> {
    const context = await this.context(issue, repositoryName);
    const selected = sourcePath(normalizedRelativePath(relativePath));
    if (!selected) throw new Error("invalid_source_path");
    let files: SourceCommitFile[];
    try {
      files = await this.workspaceChangedFiles(context, "", staged);
    } catch (error) {
      if (error instanceof Error && error.message === "command_output_too_large") throw new Error("source_diff_too_large");
      throw error;
    }
    const file = files.find((candidate) => candidate.path === selected);
    if (!file) throw new Error("source_diff_file_not_found");
    const beforePath = file.previousPath ?? file.path;
    const before =
      file.status === "added"
        ? null
        : {
            path: beforePath,
            version: staged ? ("head" as const) : ("index" as const),
            content: staged ? await this.revisionFile(context, "HEAD", beforePath) : await this.indexFile(context, beforePath),
          };
    const after =
      file.status === "deleted"
        ? null
        : {
            path: file.path,
            version: staged ? ("index" as const) : ("working-tree" as const),
            content: staged ? await this.indexFile(context, file.path) : (await this.workingFile(context, file.path)).content,
          };
    return { file, before, after };
  }

  private commandOptions(maxOutputBytes: number | null = issuePilotConfig.limits.sourceBrowser.commandOutputBytes) {
    return {
      timeout: issuePilotConfig.limits.sourceBrowser.commandMs,
      maxOutputBytes,
      environment: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" } as Record<string, string>,
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
    const range = context.parent ? [context.parent, context.revision] : ["--root", "--no-commit-id", "-r", context.revision];
    const result = await this.executor.execute(issuePilotConfig.runtime.sourceBrowser.gitExecutable, [...argumentsBeforeRange, ...range, "--", ...(selected ? [selected] : [])], this.commandOptions());
    if (result.killed) throw new Error("source_history_timeout");
    if (result.code !== 0) throw new Error("source_history_failed");
    return this.parseChangedFiles(result.stdout, "invalid_source_history_response");
  }

  private async workspaceChangedFiles(context: SourceContext, selected: string, staged: boolean): Promise<SourceCommitFile[]> {
    const result = await this.executor.execute(
      issuePilotConfig.runtime.sourceBrowser.gitExecutable,
      ["-C", context.root, "diff", ...(staged ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", "-C", "--", ...(selected ? [selected] : [])],
      this.commandOptions(),
    );
    if (result.killed) throw new Error("source_diff_timeout");
    if (result.code !== 0) throw new Error("source_diff_failed");
    const files = this.parseChangedFiles(result.stdout, "invalid_source_diff_response");
    if (staged) return files;
    const untracked = await this.executor.execute(
      issuePilotConfig.runtime.sourceBrowser.gitExecutable,
      ["-C", context.root, "ls-files", "--others", "--exclude-standard", "-z", "--", ...(selected ? [selected] : [])],
      this.commandOptions(),
    );
    if (untracked.killed) throw new Error("source_diff_timeout");
    if (untracked.code !== 0) throw new Error("source_diff_failed");
    const known = new Set(files.map((file) => file.path));
    for (const rawPath of untracked.stdout.split("\0").filter(Boolean)) {
      const filePath = sourcePath(normalizedRelativePath(rawPath));
      if (filePath && !known.has(filePath)) files.push({ status: "added", path: filePath, previousPath: null });
    }
    return files;
  }

  private parseChangedFiles(output: string, invalidResponse: string): SourceCommitFile[] {
    if (!output) return [];
    if (!output.endsWith("\0")) throw new Error(invalidResponse);
    const fields = output.slice(0, -1).split("\0");
    const files: SourceCommitFile[] = [];
    for (let index = 0; index < fields.length; ) {
      const rawStatus = fields[index++];
      if (!rawStatus) throw new Error(invalidResponse);
      const rename = /^[RC]\d{1,3}$/.test(rawStatus);
      const rawPreviousPath = rename ? fields[index++] : null;
      const rawPath = fields[index++];
      if (!rawPath || (rename && !rawPreviousPath)) throw new Error(invalidResponse);
      const filePath = sourcePath(normalizedRelativePath(rawPath));
      const previousPath = rawPreviousPath ? sourcePath(normalizedRelativePath(rawPreviousPath)) : null;
      if (!filePath || previousPath === "") throw new Error(invalidResponse);
      let status: SourceCommitFile["status"];
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
    return this.gitFile(context, `${revision}:${relativePath}`, "source_history_timeout", "source_history_failed");
  }

  private indexFile(context: SourceContext, relativePath: string): Promise<string> {
    // Explicit stage 0: a bare ":<path>" reads "0:x.txt" as stage 0 of "x.txt".
    return this.gitFile(context, `:0:${relativePath}`, "source_diff_timeout", "source_diff_failed");
  }

  private async gitFile(context: SourceContext, object: string, timeoutError: string, commandError: string): Promise<string> {
    const result = await this.executor
      .execute(issuePilotConfig.runtime.sourceBrowser.gitExecutable, ["-C", context.root, "cat-file", "blob", object], {
        ...this.commandOptions(issuePilotConfig.limits.sourceBrowser.fileBytes),
        strictStdoutUtf8: true,
      })
      .catch((error) => {
        if (error instanceof Error && error.message === "command_stdout_not_utf8") throw new Error("source_file_binary");
        if (error instanceof Error && error.message === "command_output_too_large") throw new Error("source_file_too_large");
        throw error;
      });
    if (result.killed) throw new Error(timeoutError);
    if (result.code !== 0) throw new Error(commandError);
    if (result.stdout.includes("\0")) throw new Error("source_file_binary");
    return result.stdout;
  }

  private async workingFile(context: SourceContext, relativePath: string): Promise<SourceFile> {
    const file = await this.resolvePath(context.root, relativePath);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let content: Buffer, size: number;
    try {
      if ((await realpath(`/proc/self/fd/${handle.fd}`)) !== file) throw new Error("source_path_outside_repository");
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error("source_path_not_file");
      size = metadata.size;
      if (size > issuePilotConfig.limits.sourceBrowser.fileBytes) throw new Error("source_file_too_large");
      content = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (content.subarray(0, Math.min(content.length, 8192)).includes(0)) throw new Error("source_file_binary");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      throw new Error("source_file_binary");
    }
    return { path: sourcePath(normalizedRelativePath(relativePath)), content: text, size, sha256: createHash("sha256").update(content).digest("hex") };
  }

  private async repositorySet(issue: IssueReference) {
    const [workspace, repositories] = await Promise.all([
      this.database.select({ runtimeReady: issueWorkspaces.runtimeReady }).from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue.id)).limit(1),
      this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
    ]);
    if (!workspace[0]?.runtimeReady) throw new Error("source_browser_unavailable");
    const state = classifyRepositoryState(repositories);
    if (state === "invalid") throw new Error("source_repository_state_invalid");
    return { rows: repositories, state };
  }

  private async writableContext(issue: IssueReference, repositoryName: string): Promise<SourceContext> {
    const context = await this.context(issue, repositoryName);
    const expectedStore = context.store;
    if (!expectedStore) throw new Error("source_read_only");
    const result = await this.executor.execute(
      issuePilotConfig.runtime.sourceBrowser.gitExecutable,
      ["-C", context.root, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel", "--abbrev-ref", "HEAD"],
      this.mutationOptions(),
    );
    // A killed or failed probe is not a binding mismatch; keep the two conditions distinguishable.
    if (result.killed) throw new Error("source_git_timeout");
    const [gitDirectory, commonDirectory, workingDirectory, branch] = result.stdout.trim().split("\n");
    if (
      result.code !== 0 ||
      commonDirectory !== expectedStore ||
      workingDirectory !== context.root ||
      branch !== context.workingBranch ||
      !gitDirectory ||
      path.dirname(gitDirectory) !== path.join(expectedStore, "worktrees")
    )
      throw new Error("source_git_binding_invalid");
    const pointer = (await readFile(path.join(gitDirectory, "gitdir"), "utf8")).trim();
    if (path.resolve(gitDirectory, pointer) !== path.join(context.root, ".git")) throw new Error("source_git_binding_invalid");
    return context;
  }

  private mutablePaths(paths: string[]): string[] {
    if (!paths.length || paths.length > issuePilotConfig.limits.sourceBrowser.changeFiles) throw new Error("invalid_source_path");
    return paths.map((value) => {
      const selected = sourcePath(normalizedRelativePath(value));
      if (!selected) throw new Error("invalid_source_path");
      return selected;
    });
  }

  /** Pin the validated parent so rename/symlink races cannot redirect a filesystem mutation. */
  private async withMutablePath<T>(context: SourceContext, relativePath: string, allowExisting: boolean, operation: (anchoredPath: string) => Promise<T>): Promise<T> {
    const candidate = await this.mutableDestination(context, relativePath, allowExisting);
    const parent = path.dirname(candidate);
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const failures: unknown[] = [];
    try {
      const descriptor = `/proc/self/fd/${directory.fd}`;
      if ((await realpath(descriptor)) !== parent) throw new Error("source_path_outside_repository");
      return await operation(path.join(descriptor, path.basename(candidate)));
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      try {
        await directory.close();
      } catch (error) {
        // biome-ignore lint/correctness/noUnsafeFinally: the cleanup failure is aggregated with the in-flight primary error, so no diagnostic is lost.
        throw new OperationError("source_path_cleanup_failed", failures.length ? "unknown" : "committed", { cause: new AggregateError([...failures, error]) });
      }
    }
  }

  private async mutableDestination(context: SourceContext, relativePath: string, allowExisting = false): Promise<string> {
    const selected = normalizedRelativePath(relativePath);
    if (!selected) throw new Error("invalid_source_path");
    const candidate = path.resolve(context.root, selected);
    if (!isInside(context.root, candidate)) throw new Error("invalid_source_path");
    const parent = await this.resolvePath(context.root, path.dirname(selected));
    if (path.dirname(candidate) !== parent) throw new Error("source_path_outside_repository");
    if (!allowExisting) {
      try {
        await lstat(candidate);
        throw new Error("source_path_exists");
      } catch (error) {
        if (error instanceof Error && error.message === "source_path_exists") throw error;
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    return candidate;
  }

  private mutationOptions() {
    return {
      timeout: issuePilotConfig.limits.sourceBrowser.commandMs,
      maxOutputBytes: issuePilotConfig.limits.sourceBrowser.commandOutputBytes,
      environment: { ...process.env, GIT_OPTIONAL_LOCKS: "1", GIT_LITERAL_PATHSPECS: "1" } as Record<string, string>,
    };
  }

  private async gitMutation(context: SourceContext, args: string[], failure: string): Promise<void> {
    const result = await this.executor.execute(issuePilotConfig.runtime.sourceBrowser.gitExecutable, ["-C", context.root, ...args], this.mutationOptions());
    if (result.killed) throw new Error(`${failure.replace(/_failed$/, "")}_timeout`);
    if (result.code !== 0) throw new Error(failure);
  }

  private async context(issue: IssueReference, repositoryName: string): Promise<SourceContext> {
    if (!repositoryNamePattern.test(repositoryName)) throw new Error("source_repository_not_found");
    const { rows, state } = await this.repositorySet(issue);
    const names = issueRepositoryWorkspaceNames(rows);
    const repository = rows.find((candidate) => names.get(candidate.url) === repositoryName);
    if (!repository) throw new Error("source_repository_not_found");
    const view = await resolveRecordedRepository(this.stateRoot, issue.key, repository, repositoryName, state).catch(missingPathError);
    return { ...view, workingBranch: repository.workingBranch };
  }

  private async resolvePath(root: string, relativePath: string): Promise<string> {
    const relative = normalizedRelativePath(relativePath);
    const candidate = path.resolve(root, relative);
    if (!isInside(root, candidate)) throw new Error("invalid_source_path");
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch (error) {
      missingPathError(error);
    }
    if (!isInside(root, resolved)) throw new Error("source_path_outside_repository");
    normalizedRelativePath(path.relative(root, resolved));
    return resolved;
  }
}
