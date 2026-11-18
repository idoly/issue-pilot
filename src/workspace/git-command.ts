import { localCommandExecutor, type CommandExecutor } from "../process.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { domainError } from "../domain/errors.ts";
import { OperationError } from "../operation-error.ts";

/**
 * Trusted Git runs outside SRT on model-writable worktrees. Repository-controlled configuration,
 * including the config of an embedded repository Git would recurse into, must never select a program.
 * Command-line configuration outranks repository files and is inherited by any child Git process.
 */
const trustedGitConfiguration = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "diff.ignoreSubmodules=all",
  "-c",
  "submodule.recurse=false",
  "-c",
  "core.hooksPath=/dev/null",
] as const;

export function trustedGitArgs(args: readonly string[]): string[] {
  return [...trustedGitConfiguration, ...args];
}

/** The operator's global configuration stays available (credential helpers); the system file is never read. */
export function trustedGitEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) if (value !== undefined) result[key] = value;
  result.GIT_CONFIG_NOSYSTEM = "1";
  return result;
}

interface GitIndexOptions {
  executor?: CommandExecutor;
  gitExecutable?: string;
  environment?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}

/**
 * List index gitlink changes against HEAD. Comparing HEAD with the index never inspects a
 * submodule worktree, and plumbing diff-index ignores the porcelain diff.ignoreSubmodules setting.
 */
export async function indexGitlinkChanges(root: string, options: GitIndexOptions = {}): Promise<Array<{ path: string; added: boolean }>> {
  const executor = options.executor ?? localCommandExecutor;
  let pending = "";
  const changes: Array<{ path: string; added: boolean }> = [];
  let header: { oldMode: string; newMode: string } | null = null;
  const consume = (chunk: string) => {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\0")) >= 0) {
      const field = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (!header) {
        const match = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40} [0-9a-f]{40} [ADMT]$/.exec(field);
        if (!match) throw new Error("workspace_git_index_invalid");
        header = { oldMode: match[1]!, newMode: match[2]! };
      } else {
        if (!field) throw new Error("workspace_git_index_invalid");
        if (header.oldMode === "160000" || header.newMode === "160000") changes.push({ path: field, added: header.newMode === "160000" && header.oldMode !== "160000" });
        header = null;
      }
    }
  };
  const result = await executor.execute(
    options.gitExecutable ?? "git",
    trustedGitArgs(["--no-optional-locks", "-C", root, "diff-index", "--cached", "--raw", "-z", "--no-renames", "--ignore-submodules=none", "HEAD", "--"]),
    {
      timeout: options.timeout ?? issuePilotConfig.limits.process.gitOperationMs,
      maxOutputBytes: null,
      // These decoded paths may become reset arguments; replacement decoding could select another index entry.
      strictStdoutUtf8: true,
      environment: trustedGitEnvironment(options.environment),
      onStdout: consume,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (result.stdout) consume(result.stdout);
  if (result.killed || result.code !== 0 || pending || header) throw new Error("workspace_git_index_invalid", { cause: new Error(result.stderr) });
  return changes;
}

/** Refuse new embedded repositories and unstage only their exact paths; recorded submodules remain usable. */
export async function assertNoEmbeddedRepository(root: string, options: GitIndexOptions = {}): Promise<void> {
  const gitlinks = await indexGitlinkChanges(root, options).catch((error: unknown) => {
    throw new Error("workspace_git_index_invalid", { cause: error });
  });
  const added = gitlinks.filter((entry) => entry.added).map((entry) => entry.path);
  if (!added.length) return;
  const refusal = domainError("embedded_repository_not_allowed");
  try {
    const result = await (options.executor ?? localCommandExecutor).execute(
      options.gitExecutable ?? "git",
      trustedGitArgs(["--literal-pathspecs", "-C", root, "reset", "-q", "HEAD", "--", ...added]),
      {
        // Once inspection found an invalid index, settle this bounded cleanup even if the caller cancels.
        timeout: options.timeout ?? issuePilotConfig.limits.process.gitOperationMs,
        maxOutputBytes: issuePilotConfig.limits.process.gitOutputBytes,
        environment: trustedGitEnvironment(options.environment),
      },
    );
    if (result.killed || result.code !== 0) throw new Error("workspace_git_index_reset_failed", { cause: result });
  } catch (cleanup) {
    throw new OperationError("workspace_git_index_cleanup_failed", "unknown", { cause: new AggregateError([refusal, cleanup]) });
  }
  throw refusal;
}
