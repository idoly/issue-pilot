import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { applicationConfig } from "../src/config.ts";
import { parseIssueKey } from "../src/domain/contracts.ts";
import { issueRepositoryStorePath, issueRepositoryWorkspaceNames, repositoryStorePath } from "../src/workspace/git.ts";
import {
  inspectLegacyIssueBranch,
  isolateIssueWorktree,
  preserveReleasedIssueBranch,
  readIssueBranchCommit,
  readIssuePublicationCommit,
  validateIssueGitStore,
  validateIssueWorktreeBinding,
  type LegacyIssueBranch,
} from "../src/workspace/issue-git.ts";
import { ApplicationStateLease } from "../src/workspace/state-lease.ts";
import { assertIssueRoot, classifyRepositoryState } from "../src/workspace/state.ts";

type Entry = { issue: string; repository: string; branch: string; sharedCommit: string; releasedEvidence?: string };
type RepositoryRow = { url: string; localPath: string | null; workingBranch: string | null; workspaceName: string | null; base: string | null };
type Plan = { action: "already-private" } | { action: "isolate-worktree" | "preserve-released"; binding: LegacyIssueBranch };
const commitPattern = /^[a-f0-9]{40}$/;
const repositoryPattern = /^[a-f0-9]{20}$/;

function parseManifest(value: unknown): Entry[] {
  if (!Array.isArray(value) || !value.length) throw new Error("invalid_development_git_manifest");
  const selected = new Set<string>();
  return value.map((entry: Partial<Entry> | null) => {
    if (
      !entry ||
      typeof entry.issue !== "string" ||
      entry.issue !== parseIssueKey(entry.issue) ||
      typeof entry.repository !== "string" ||
      !repositoryPattern.test(entry.repository) ||
      typeof entry.branch !== "string" ||
      !entry.branch ||
      typeof entry.sharedCommit !== "string" ||
      !commitPattern.test(entry.sharedCommit) ||
      (entry.releasedEvidence !== undefined && (typeof entry.releasedEvidence !== "string" || !entry.releasedEvidence.trim())) ||
      Object.keys(entry).some((key) => !["issue", "repository", "branch", "sharedCommit", "releasedEvidence"].includes(key))
    )
      throw new Error("invalid_development_git_manifest_entry");
    const key = `${entry.issue}:${entry.repository}`;
    if (selected.has(key)) throw new Error("duplicate_development_git_manifest_entry");
    selected.add(key);
    return entry as Entry;
  });
}

const statIfPresent = (file: string) =>
  lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

async function inspect(root: string, database: DatabaseSync, entry: Entry): Promise<Plan> {
  const rows = database
    .prepare(`SELECT r.url, r.local_path AS localPath, r.working_branch AS workingBranch, r.workspace_name AS workspaceName, r.commit_before AS base
      FROM issue_repositories r JOIN issues i ON i.id = r.issue_id JOIN environments e ON e.id = i.environment_id WHERE i.key = ? AND e.kind = 'dev'`)
    .all(entry.issue) as unknown as RepositoryRow[];
  const state = classifyRepositoryState(rows);
  if (state !== "development_workspace" && state !== "development_snapshot") throw new Error("invalid_development_repository_state");
  const matches = rows.filter((row) => path.basename(repositoryStorePath(root, row.url)) === entry.repository);
  const row = matches[0];
  if (matches.length !== 1 || !row || row.workingBranch !== entry.branch || !row.base || !commitPattern.test(row.base)) throw new Error("development_git_binding_not_recorded");
  if (database.prepare("SELECT COUNT(*) AS count FROM issue_repositories WHERE url = ? AND working_branch = ?").get(row.url, entry.branch)?.count !== 1)
    throw new Error("development_git_branch_has_multiple_owners");
  const directory = await assertIssueRoot(root, entry.issue);
  const names = issueRepositoryWorkspaceNames(rows);
  const workspace = row.localPath ?? undefined;
  if (workspace !== undefined && workspace !== path.join(directory, names.get(row.url)!)) throw new Error("recorded_worktree_path_invalid");
  const privateStore = issueRepositoryStorePath(root, entry.issue, row.url);
  const parent = path.dirname(privateStore);
  const parentStat = await statIfPresent(parent);
  if (parentStat && (!parentStat.isDirectory() || (await realpath(parent)) !== parent)) throw new Error("workspace_git_store_invalid");
  if (await statIfPresent(privateStore)) {
    await validateIssueGitStore(privateStore, row.url);
    await readIssueBranchCommit(privateStore, entry.branch);
    await readIssuePublicationCommit(privateStore, entry.branch);
    if (workspace) await validateIssueWorktreeBinding(privateStore, workspace, entry.branch);
    return { action: "already-private" };
  }
  if (!workspace && !entry.releasedEvidence) throw new Error("released_branch_evidence_required");
  const binding = {
    sharedStore: repositoryStorePath(root, row.url),
    privateStore,
    branch: entry.branch,
    commit: entry.sharedCommit,
    base: row.base,
    ...(workspace ? { workspace } : {}),
  };
  await inspectLegacyIssueBranch(binding, row.url);
  return { action: workspace ? "isolate-worktree" : "preserve-released", binding };
}

function diagnostic(error: unknown): string {
  return error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "development_git_migration_failed";
}

async function migrate() {
  const { values } = parseArgs({ options: { "state-root": { type: "string" }, manifest: { type: "string" }, apply: { type: "boolean" } } });
  const root = values["state-root"];
  if (!root || !path.isAbsolute(root)) throw new Error("absolute_state_root_required");
  if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory()) throw new Error("invalid_state_root");
  if (!values.manifest) throw new Error("development_git_manifest_required");
  const entries = parseManifest(JSON.parse(await readFile(values.manifest, "utf8")));
  const databaseFile = path.join(root, applicationConfig.state.databaseFile);
  if (!(await lstat(databaseFile)).isFile() || (await realpath(databaseFile)) !== databaseFile) throw new Error("invalid_state_database");
  const lease = new ApplicationStateLease(root, { recoverStaleSocket: false });
  try {
    if (values.apply) await lease.start();
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      database.exec("BEGIN");
      const plans: Array<{ entry: Entry; plan: Plan }> = [];
      for (const entry of entries) {
        try {
          plans.push({ entry, plan: await inspect(root, database, entry) });
        } catch (error) {
          console.error(`${entry.issue} ${entry.repository} ${diagnostic(error)}`);
        }
      }
      if (plans.length !== entries.length) throw new Error("development_git_preflight_failed");
      console.log(JSON.stringify({ mode: values.apply ? "apply" : "dry-run", entries: plans.map(({ entry, plan }) => ({ issue: entry.issue, repository: entry.repository, action: plan.action })) }));
      if (values.apply)
        for (const { entry, plan } of plans) {
          if (plan.action === "already-private") continue;
          try {
            // Recheck immediately before the write; external Git writers must also remain stopped.
            const current = await inspect(root, database, entry);
            if (current.action !== plan.action) throw new Error("development_git_plan_changed");
            if (current.action === "isolate-worktree") {
              const { sharedStore, privateStore, workspace, branch, base, commit } = current.binding;
              await isolateIssueWorktree(sharedStore, privateStore, workspace!, branch, base, commit);
            } else await preserveReleasedIssueBranch(current.binding);
            console.log(JSON.stringify({ issue: entry.issue, repository: entry.repository, status: "migrated" }));
          } catch (error) {
            console.error(`${entry.issue} ${entry.repository} ${diagnostic(error)}`);
            throw new Error("development_git_apply_stopped");
          }
        }
    } finally {
      database.close();
    }
  } finally {
    await lease.close();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(diagnostic(error));
  process.exitCode = 1;
}
