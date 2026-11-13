import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { applicationConfig } from "../src/config.ts";
import { assertIssueRoot, assertIssueStateLayout } from "../src/workspace/state.ts";
import { issueRepositoryStorePath, repositoryStorePath, WorktreeManager } from "../src/workspace/git.ts";
import { readIssueBranchCommit, validateIssueGitStore, validateIssueWorktreeBinding } from "../src/workspace/issue-git.ts";

async function checkDevelopmentGit(root: string, database: DatabaseSync): Promise<void> {
  const rows = database
    .prepare(`SELECT i.key, r.url, r.working_branch, r.local_path, r.workspace_name
      FROM issue_repositories r JOIN issues i ON i.id = r.issue_id
      WHERE r.working_branch IS NOT NULL OR r.local_path IS NOT NULL ORDER BY i.key, r.id`)
    .all();
  const counts = { privateVerified: 0, privateInvalid: 0, sharedWorktreeVerified: 0, sharedRefOnly: 0, unresolved: 0, mirrorEqual: 0, mirrorDifferent: 0, mirrorUnavailable: 0 };
  for (const row of rows) {
    const key = String(row.key),
      url = String(row.url),
      shared = repositoryStorePath(root, url);
    const report = (code: "privateInvalid" | "sharedRefOnly" | "unresolved") => {
      counts[code]++;
      console.error(`${key} ${path.basename(shared)} ${code}`);
    };
    const branch = row.working_branch;
    const local = typeof row.local_path === "string" ? row.local_path : undefined;
    if (typeof branch !== "string" || !branch) {
      report("unresolved");
      continue;
    }
    let own: string;
    let exists: boolean;
    try {
      const directory = await assertIssueRoot(root, key);
      if (local !== undefined && (local !== path.join(directory, path.basename(local)) || (row.workspace_name && row.workspace_name !== path.basename(local))))
        throw new Error("recorded_worktree_path_invalid");
      own = issueRepositoryStorePath(root, key, url);
      exists = await lstat(own).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
    } catch {
      report("unresolved");
      continue;
    }
    const sharedTip = await (async () => {
      if (!(await lstat(shared)).isDirectory() || (await realpath(shared)) !== shared) throw new Error("shared_store_invalid");
      return readIssueBranchCommit(shared, branch);
    })().catch(() => undefined);
    if (exists) {
      try {
        await validateIssueGitStore(own, url);
        const tip = await readIssueBranchCommit(own, branch);
        if (local) await validateIssueWorktreeBinding(own, local, branch);
        counts.privateVerified++;
        counts[!sharedTip ? "mirrorUnavailable" : sharedTip === tip ? "mirrorEqual" : "mirrorDifferent"]++;
      } catch {
        report("privateInvalid");
      }
    } else if (sharedTip && local === undefined) {
      // A released branch has no worktree pointer to distinguish history from a lost private store.
      report("sharedRefOnly");
    } else if (sharedTip && local) {
      try {
        await validateIssueWorktreeBinding(shared, local, branch);
        counts.sharedWorktreeVerified++;
      } catch {
        report("unresolved");
      }
    } else report("unresolved");
  }
  console.log(JSON.stringify({ developmentIssues: new Set(rows.map(({ key }) => key)).size, developmentRepositories: rows.length, ...counts }));
  if (counts.privateInvalid || counts.sharedRefOnly || counts.unresolved) process.exitCode = 1;
}

const { values } = parseArgs({ options: { "state-root": { type: "string" }, "shared-git": { type: "boolean" }, "development-git": { type: "boolean" } } });
const root = values["state-root"];
if (!root || !path.isAbsolute(root)) throw new Error("absolute_state_root_required");

if (values["shared-git"]) {
  await WorktreeManager.assertSharedState(root);
  console.log("Checked shared Git snapshots");
}

const database = new DatabaseSync(path.join(root, applicationConfig.state.databaseFile), { readOnly: true });
try {
  if (values["development-git"]) await checkDevelopmentGit(root, database);
  else {
    const missing = database.prepare("SELECT i.key FROM issues AS i LEFT JOIN issue_workspaces AS w ON w.issue_id = i.id WHERE w.issue_id IS NULL LIMIT 1").get();
    if (missing) throw new Error(`issue_workspace_missing:${missing.key}`);
    const invalid = database.prepare("SELECT key FROM issues WHERE (status = 'resolved') <> (resolved_at IS NOT NULL) LIMIT 1").get();
    if (invalid) throw new Error(`issue_resolution_state_invalid:${invalid.key}`);
    const releaseMismatch = database
      .prepare(
        `SELECT i.key FROM issues AS i JOIN issue_workspaces AS w ON w.issue_id = i.id
         WHERE (w.released_at IS NOT NULL) <> (
           EXISTS (SELECT 1 FROM issue_repositories AS r WHERE r.issue_id = i.id)
           AND NOT EXISTS (SELECT 1 FROM issue_repositories AS r WHERE r.issue_id = i.id AND (r.local_path IS NOT NULL OR r.working_branch IS NULL))
         )
         LIMIT 1`,
      )
      .get();
    if (releaseMismatch) throw new Error(`workspace_release_state_invalid:${releaseMismatch.key}`);
    const keys = database
      .prepare("SELECT key FROM issues")
      .all()
      .map(({ key }) => String(key));
    await assertIssueStateLayout(root, keys);
    console.log(`Checked ${keys.length} Issue records and directory ownership`);
  }
} finally {
  database.close();
}
