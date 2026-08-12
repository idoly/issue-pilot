import { eq } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { environments, issueRepositories, issueWorkspaces, issues } from "../db/schema.ts";
import type { IssueType } from "../domain/contracts.ts";
import { CodeServerManager } from "./code-server.ts";
import { issueRepositoryWorkspaceNames, WorktreeManager } from "./git.ts";
import { prepareProjectWrappers } from "./project-wrappers.ts";
import { prepareIssueRuntime, prepareIssueRuntimeBatch, type RuntimePreparationResult } from "./runtime.ts";
import { assertManagedIssueWorkspaceLayout, classifyRepositoryState, issueWorkspaceRoot, pathExists } from "./state.ts";

type CodeServer = Pick<CodeServerManager, "ensure">;

export function developmentWorktreeMode(issueType: IssueType): "hotfix" | "feature" {
  if (issueType === "defect_fix") return "hotfix";
  if (issueType === "feature_development") return "feature";
  throw new Error("unsupported_dev_issue_type");
}

export async function prepareDevelopmentIssueRuntime(
  database: Database,
  stateRoot: string,
  issue: { id: string; key: string },
  codeServer: CodeServer = new CodeServerManager(stateRoot),
  worktrees = new WorktreeManager(stateRoot),
): Promise<string> {
  const repositories = await database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
  if (!repositories.length) throw new Error("issue_has_no_repositories");
  const workspaceRoot = issueWorkspaceRoot(stateRoot, issue.key);
  const names = issueRepositoryWorkspaceNames(repositories);
  let runtimeRoot: string;

  if (await pathExists(workspaceRoot)) {
    if (classifyRepositoryState(repositories) !== "development_workspace") throw new Error("development_repository_state_invalid");
    await assertManagedIssueWorkspaceLayout(workspaceRoot, repositories.map((repository) => repository.localPath!));
    runtimeRoot = await prepareIssueRuntime(
      stateRoot,
      issue.key,
      repositories.map((repository) => ({ name: names.get(repository.url)!, repositoryPath: repository.localPath! })),
      "write",
    );
    await prepareProjectWrappers(runtimeRoot);
  } else {
    if (classifyRepositoryState(repositories) !== "development_snapshot") throw new Error("development_repository_state_invalid");
    const snapshots = [];
    for (const repository of repositories) {
      const snapshot = await worktrees.prepareBranchSnapshot({
        url: repository.url,
        baseBranch: repository.baseBranch,
        workingBranch: repository.workingBranch!,
      });
      snapshots.push({ name: names.get(repository.url)!, repositoryPath: snapshot.workspacePath });
    }
    runtimeRoot = await prepareIssueRuntime(stateRoot, issue.key, snapshots, "read");
  }

  await codeServer.ensure(issue.key, runtimeRoot);
  await database.update(issueWorkspaces).set({ codeServerReady: true, lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
  return runtimeRoot;
}

export async function prepareDevelopmentIssueRuntimes(
  database: Database,
  stateRoot: string,
  codeServer: CodeServer = new CodeServerManager(stateRoot),
): Promise<RuntimePreparationResult> {
  const developmentIssues = await database.select({ id: issues.id, key: issues.key }).from(issues)
    .innerJoin(environments, eq(environments.id, issues.environmentId))
    .where(eq(environments.kind, "dev"));
  const worktrees = new WorktreeManager(stateRoot);
  return prepareIssueRuntimeBatch(
    database,
    developmentIssues,
    (issue) => prepareDevelopmentIssueRuntime(database, stateRoot, issue, codeServer, worktrees),
  );
}
