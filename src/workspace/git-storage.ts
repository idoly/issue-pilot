import { execFile } from "node:child_process";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { gitRoot, legacyRepositoriesRoot, legacySharedCheckoutsRoot, repositoriesRoot, sharedCheckoutsRoot } from "./state.ts";

const execFileAsync = promisify(execFile);

interface RepositoryWorktrees {
  name: string;
  paths: string[];
}

async function directoryStatus(candidate: string): Promise<"absent" | "directory"> {
  try {
    if (!(await stat(candidate)).isDirectory()) throw new Error(`git_storage_not_directory:${candidate}`);
    return "directory";
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "absent";
    throw error;
  }
}

async function repositoryWorktrees(repositoryStorage: string): Promise<RepositoryWorktrees[]> {
  if (await directoryStatus(repositoryStorage) === "absent") return [];
  const entries = await readdir(repositoryStorage, { withFileTypes: true });
  const result: RepositoryWorktrees[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) throw new Error(`git_storage_unexpected_repository:${entry.name}`);
    const repository = path.join(repositoryStorage, entry.name);
    const { stdout } = await execFileAsync("git", ["-C", repository, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8", timeout: 30_000 });
    const paths = stdout.split("\0").filter((value) => value.startsWith("worktree ")).map((value) => path.resolve(value.slice("worktree ".length)));
    result.push({ name: entry.name, paths: paths.filter((candidate) => candidate !== path.resolve(repository)) });
  }
  return result;
}

function movePath(candidate: string, sourceRoot: string, destinationRoot: string): string {
  const relative = path.relative(sourceRoot, candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? path.join(destinationRoot, relative) : candidate;
}

async function repairWorktrees(repositoryStorage: string, worktrees: RepositoryWorktrees[], paths: (candidate: string) => string): Promise<void> {
  for (const repository of worktrees) {
    const repairedPaths = repository.paths.map(paths);
    if (!repairedPaths.length) continue;
    await execFileAsync("git", ["-C", path.join(repositoryStorage, repository.name), "worktree", "repair", "--relative-paths", ...repairedPaths], { timeout: 30_000 });
  }
}

export async function migrateGitStorage(stateRoot: string): Promise<{ repositories: boolean; checkouts: boolean }> {
  const moves = [
    { name: "repositories" as const, source: legacyRepositoriesRoot(stateRoot), destination: repositoriesRoot(stateRoot) },
    { name: "checkouts" as const, source: legacySharedCheckoutsRoot(stateRoot), destination: sharedCheckoutsRoot(stateRoot) },
  ];
  const statuses = await Promise.all(moves.map(async (move) => ({
    ...move,
    sourceStatus: await directoryStatus(move.source),
    destinationStatus: await directoryStatus(move.destination),
  })));
  for (const item of statuses) {
    if (item.sourceStatus === "directory" && item.destinationStatus === "directory") throw new Error(`git_storage_conflict:${item.name}`);
  }

  const oldRepositories = statuses[0]!.sourceStatus === "directory" ? statuses[0]!.source : statuses[0]!.destination;
  const worktrees = await repositoryWorktrees(oldRepositories);
  await mkdir(gitRoot(stateRoot), { recursive: true, mode: 0o700 });
  const migrated: Array<(typeof statuses)[number]> = [];
  try {
    for (const item of statuses) {
      if (item.sourceStatus === "absent") continue;
      await rename(item.source, item.destination);
      migrated.push(item);
    }
    if (migrated.length) {
      await repairWorktrees(repositoriesRoot(stateRoot), worktrees, (candidate) =>
        movePath(candidate, legacySharedCheckoutsRoot(stateRoot), sharedCheckoutsRoot(stateRoot)));
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const item of migrated.reverse()) {
      try { await rename(item.destination, item.source); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    try { await repairWorktrees(oldRepositories, worktrees, (candidate) => candidate); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "git_storage_rollback_failed");
    throw error;
  }
  return {
    repositories: migrated.some(({ name }) => name === "repositories"),
    checkouts: migrated.some(({ name }) => name === "checkouts"),
  };
}
