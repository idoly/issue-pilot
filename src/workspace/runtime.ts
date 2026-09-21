import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import pMap from "p-map";

import type { Database } from "../db/client.ts";
import { issueWorkspaces } from "../db/schema.ts";
import { errorMessage } from "../domain/contracts.ts";
import { replaceGeneratedDirectory } from "./generated-directory.ts";
import { issueRoot, issueRuntimeRoot, issueWorkspaceRoot, sharedCheckoutsRoot } from "./state.ts";

export interface IssueRuntimeRepository {
  name: string;
  repositoryPath: string;
}

export interface RelatedIssueRuntime {
  key: string;
  metadata: Record<string, unknown>;
  conversationPath: string;
  repositories: IssueRuntimeRepository[];
}

export type IssueRuntimeAccess = "read" | "write";

export interface RuntimePreparationResult {
  prepared: string[];
  blocked: Array<{ issueKey: string; reason: string }>;
}

export async function prepareIssueRuntimeBatch<T extends { id: string; key: string }>(
  database: Database,
  issueRows: T[],
  prepareRuntime: (issue: T) => Promise<unknown>,
  options: { concurrency?: number } = {},
): Promise<RuntimePreparationResult> {
  const outcomes = await pMap(issueRows, async (issue) => {
    try {
      await prepareRuntime(issue);
      return { issueKey: issue.key };
    } catch (error) {
      await database.update(issueWorkspaces).set({ runtimeReady: false, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id)).catch(() => undefined);
      return { issueKey: issue.key, reason: errorMessage(error) };
    }
  }, { concurrency: options.concurrency ?? 1, stopOnError: false });
  return {
    prepared: outcomes.filter((outcome) => outcome.reason === undefined).map(({ issueKey }) => issueKey),
    blocked: outcomes.filter((outcome): outcome is { issueKey: string; reason: string } => outcome.reason !== undefined),
  };
}

function managedRepository(stateRoot: string, issueKey: string, repositoryPath: string, access: IssueRuntimeAccess): string {
  const resolved = path.resolve(repositoryPath);
  if (access === "write") {
    if (path.dirname(resolved) !== issueWorkspaceRoot(stateRoot, issueKey)) throw new Error("repository_workspace_outside_issue_root");
    return resolved;
  }
  const checkoutRoot = sharedCheckoutsRoot(stateRoot);
  const relative = path.relative(checkoutRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("repository_checkout_outside_shared_root");
  return resolved;
}

export async function prepareIssueRuntime(
  stateRoot: string,
  issueKey: string,
  repositories: IssueRuntimeRepository[],
  access: IssueRuntimeAccess,
  relatedIssues: RelatedIssueRuntime[] = [],
): Promise<string> {
  const issueDirectory = issueRoot(stateRoot, issueKey);
  const runtimeRoot = issueRuntimeRoot(stateRoot, issueKey);
  const operationId = randomUUID();
  const temporaryRoot = path.join(issueDirectory, `.runtime-${operationId}`);
  const previousRoot = path.join(issueDirectory, `.runtime-previous-${operationId}`);
  const names = new Set<string>();

  await mkdir(issueDirectory, { recursive: true, mode: 0o700 });
  await chmod(issueDirectory, 0o700);
  try {
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    for (const repository of repositories) {
      if (!/^[a-z0-9._-]+$/.test(repository.name) || names.has(repository.name) || repository.name === "related-issues") throw new Error("invalid_runtime_repository_name");
      names.add(repository.name);
      const repositoryTarget = managedRepository(stateRoot, issueKey, repository.repositoryPath, access);
      await symlink(path.relative(temporaryRoot, repositoryTarget), path.join(temporaryRoot, repository.name), "dir");
    }
    if (relatedIssues.length) {
      const relatedRoot = path.join(temporaryRoot, "related-issues");
      await mkdir(relatedRoot, { mode: 0o700 });
      for (const relatedIssue of relatedIssues) {
        const normalizedKey = relatedIssue.key.toLowerCase();
        if (!/^issue-[0-9]{8}-[0-9]{3,}$/.test(normalizedKey)) throw new Error("invalid_related_issue_key");
        const relatedIssueRoot = path.join(relatedRoot, normalizedKey);
        const repositoryRoot = path.join(relatedIssueRoot, "repositories");
        await mkdir(repositoryRoot, { recursive: true, mode: 0o700 });
        await writeFile(path.join(relatedIssueRoot, "issue.json"), `${JSON.stringify(relatedIssue.metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o400 });
        await symlink(path.relative(relatedIssueRoot, relatedIssue.conversationPath), path.join(relatedIssueRoot, "conversation.jsonl"), "file");
        const relatedNames = new Set<string>();
        for (const repository of relatedIssue.repositories) {
          if (!/^[a-z0-9._-]+$/.test(repository.name) || relatedNames.has(repository.name)) throw new Error("invalid_runtime_repository_name");
          relatedNames.add(repository.name);
          const repositoryTarget = managedRepository(stateRoot, issueKey, repository.repositoryPath, "read");
          await symlink(path.relative(repositoryRoot, repositoryTarget), path.join(repositoryRoot, repository.name), "dir");
        }
      }
    }

    await replaceGeneratedDirectory(runtimeRoot, temporaryRoot, previousRoot);
    return runtimeRoot;
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
