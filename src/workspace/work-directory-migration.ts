import { lstat, mkdir, readdir, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import { legacyIssueRoot, issueRoot } from "./state.ts";

export interface IssueWorkMigrationEntry { issueKey: string; source: string; target: string }

/** Explicit offline migration of the former issues/<key>/work layout. Never adopts unknown directories. */
export async function planIssueWorkMigration(stateRoot: string, issueKeys: string[]): Promise<IssueWorkMigrationEntry[]> {
  const plan: IssueWorkMigrationEntry[] = [];
  for (const issueKey of issueKeys) {
    const source = path.join(legacyIssueRoot(stateRoot, issueKey), "work");
    const metadata = await lstat(source).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!metadata) continue;
    if (!metadata.isDirectory()) throw new Error("issue_work_migration_source_invalid");
    const targetRoot = issueRoot(stateRoot, issueKey);
    const targetMetadata = await lstat(targetRoot).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (targetMetadata && !targetMetadata.isDirectory()) throw new Error("issue_work_migration_target_invalid");
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const target = path.join(targetRoot, entry.name);
      const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (existing) throw new Error(`issue_work_migration_collision:${issueKey}/${entry.name}`);
      // Relative symlinks and nested Git repositories can carry old absolute layout assumptions.
      // Keep them for explicit owner inspection rather than guessing how to rewrite them.
      await assertMovable(path.join(source, entry.name));
      plan.push({ issueKey, source: path.join(source, entry.name), target });
    }
  }
  return plan;
}

async function assertMovable(selected: string): Promise<void> {
  const metadata = await lstat(selected);
  if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) throw new Error("issue_work_migration_requires_inspection");
  if (metadata.isDirectory()) for (const entry of await readdir(selected)) {
    if (entry.toLowerCase() === ".git") throw new Error("issue_work_migration_requires_inspection");
    await assertMovable(path.join(selected, entry));
  }
}

export async function applyIssueWorkMigration(plan: IssueWorkMigrationEntry[], commit: () => Promise<void>): Promise<void> {
  const moved: IssueWorkMigrationEntry[] = [];
  const created = new Set<string>();
  try {
    for (const entry of plan) {
      const root = path.dirname(entry.target);
      await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
      try { await mkdir(root, { mode: 0o700 }); created.add(root); }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
      const existing = await lstat(entry.target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (existing) throw new Error("issue_work_migration_collision");
      await rename(entry.source, entry.target);
      moved.push(entry);
    }
    await commit();
  } catch (error) {
    const failures: unknown[] = [];
    for (const entry of moved.reverse()) try { await rename(entry.target, entry.source); } catch (failure) { failures.push(failure); }
    for (const root of created) try { await rmdir(root); } catch (failure) { failures.push(failure); }
    if (failures.length) throw new AggregateError([error, ...failures], "issue_work_migration_rollback_failed");
    throw error;
  }
}
