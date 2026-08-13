import { eq } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { environments, issues } from "../db/schema.ts";
import { CodeServerManager } from "./code-server.ts";
import { WorktreeManager } from "./git.ts";
import { IssueProjectManager } from "./project.ts";
import { prepareIssueRuntimeBatch, type RuntimePreparationResult } from "./runtime.ts";

export { developmentWorktreeMode } from "./project.ts";

type CodeServer = Pick<CodeServerManager, "ensure">;

export async function prepareDevelopmentIssueRuntime(
  database: Database,
  stateRoot: string,
  issue: { id: string; key: string; type?: typeof issues.$inferSelect.type },
  codeServer: CodeServer = new CodeServerManager(stateRoot),
  worktrees = new WorktreeManager(stateRoot),
): Promise<string> {
  const issueType = issue.type ?? (await database.select({ type: issues.type }).from(issues).where(eq(issues.id, issue.id)).limit(1))[0]?.type;
  if (!issueType) throw new Error("issue_not_found");
  return new IssueProjectManager(database, stateRoot, worktrees).hydrateDevelopmentRuntime({ ...issue, type: issueType }, codeServer);
}

export async function prepareDevelopmentIssueRuntimes(
  database: Database,
  stateRoot: string,
  codeServer: CodeServer = new CodeServerManager(stateRoot),
): Promise<RuntimePreparationResult> {
  const developmentIssues = await database.select({ id: issues.id, key: issues.key, type: issues.type }).from(issues)
    .innerJoin(environments, eq(environments.id, issues.environmentId))
    .where(eq(environments.kind, "dev"));
  const project = new IssueProjectManager(database, stateRoot);
  return prepareIssueRuntimeBatch(database, developmentIssues, (issue) => project.hydrateDevelopmentRuntime(issue, codeServer));
}
