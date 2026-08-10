import { access } from "node:fs/promises";

import { eq } from "drizzle-orm";

import type { openDatabase } from "../db/client.ts";
import { environments, issueRepositories, issues } from "../db/schema.ts";
import { prepareProjectWrappers } from "./project-wrappers.ts";
import { assertManagedIssueWorkspaceLayout, ensureIssueWorkspaceLink, issueRuntimeRoot, issueWorkspaceRoot } from "./state.ts";

type Database = ReturnType<typeof openDatabase>["db"];

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
}

export async function prepareDevelopmentIssueRuntimes(
  database: Database,
  stateRoot: string,
): Promise<{ prepared: string[]; blocked: Array<{ issueKey: string; reason: string }> }> {
  const developmentIssues = await database.select({ id: issues.id, key: issues.key }).from(issues)
    .innerJoin(environments, eq(environments.id, issues.environmentId))
    .where(eq(environments.kind, "dev"));
  const prepared: string[] = [];
  const blocked: Array<{ issueKey: string; reason: string }> = [];

  for (const issue of developmentIssues) {
    const workspaceRoot = issueWorkspaceRoot(stateRoot, issue.key);
    if (!await exists(workspaceRoot)) continue;
    try {
      const repositories = await database.select({ localPath: issueRepositories.localPath }).from(issueRepositories)
        .where(eq(issueRepositories.issueId, issue.id));
      await assertManagedIssueWorkspaceLayout(workspaceRoot, repositories.flatMap(({ localPath }) => localPath ? [localPath] : []));
      await Promise.all([
        ensureIssueWorkspaceLink(stateRoot, issue.key),
        prepareProjectWrappers(issueRuntimeRoot(stateRoot, issue.key)),
      ]);
      prepared.push(issue.key);
    } catch (error) {
      blocked.push({ issueKey: issue.key, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { prepared, blocked };
}
