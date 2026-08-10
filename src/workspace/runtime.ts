import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { issueWorkspaces } from "../db/schema.ts";
import { errorMessage } from "../domain/contracts.ts";
import { issueRoot, issueRuntimeRoot, issueRuntimeWorkspaceFile, issueWorkspaceRoot, sharedCheckoutsRoot } from "./state.ts";

export interface IssueRuntimeRepository {
  name: string;
  repositoryPath: string;
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
): Promise<RuntimePreparationResult> {
  const prepared: string[] = [];
  const blocked: RuntimePreparationResult["blocked"] = [];
  for (const issue of issueRows) {
    try {
      await prepareRuntime(issue);
      prepared.push(issue.key);
    } catch (error) {
      await database.update(issueWorkspaces).set({ codeServerReady: false, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id)).catch(() => undefined);
      blocked.push({ issueKey: issue.key, reason: errorMessage(error) });
    }
  }
  return { prepared, blocked };
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
): Promise<string> {
  const issueDirectory = issueRoot(stateRoot, issueKey);
  const runtimeRoot = issueRuntimeRoot(stateRoot, issueKey);
  const temporaryRoot = path.join(issueDirectory, `.runtime-${randomUUID()}`);
  const names = new Set<string>();

  await mkdir(issueDirectory, { recursive: true, mode: 0o700 });
  await chmod(issueDirectory, 0o700);
  try {
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    for (const repository of repositories) {
      if (!/^[a-z0-9._-]+$/.test(repository.name) || names.has(repository.name)) throw new Error("invalid_runtime_repository_name");
      names.add(repository.name);
      const repositoryTarget = managedRepository(stateRoot, issueKey, repository.repositoryPath, access);
      await symlink(path.relative(temporaryRoot, repositoryTarget), path.join(temporaryRoot, repository.name), "dir");
    }
    const workspaceFile = path.join(temporaryRoot, path.basename(issueRuntimeWorkspaceFile(stateRoot, issueKey)));
    const workspace = {
      folders: repositories.map((repository) => ({ name: repository.name, path: repository.name })),
      ...(access === "read" ? { settings: { "files.readonlyInclude": { "**": true } } } : {}),
    };
    await writeFile(workspaceFile, `${JSON.stringify(workspace, null, 2)}\n`, { mode: 0o400 });
    await chmod(workspaceFile, 0o400);

    await rm(runtimeRoot, { recursive: true, force: true });
    await rename(temporaryRoot, runtimeRoot);
    return runtimeRoot;
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
