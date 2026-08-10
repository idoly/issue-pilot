import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { normalizeIssueKey } from "../domain/contracts.ts";

const execFileAsync = promisify(execFile);

function issueSegment(issueKey: string): string {
  return normalizeIssueKey(issueKey).toLowerCase();
}

export function workspacesRoot(stateRoot: string): string {
  return path.resolve(stateRoot, "workspaces");
}

export function issueWorkspaceRoot(stateRoot: string, issueKey: string): string {
  return path.join(workspacesRoot(stateRoot), issueSegment(issueKey));
}

export function issueSessionRoot(stateRoot: string, issueKey: string): string {
  return path.resolve(stateRoot, "sessions", issueSegment(issueKey));
}

export function attachmentsRoot(stateRoot: string): string {
  return path.resolve(stateRoot, "attachments");
}

export function issueAttachmentRoot(stateRoot: string, issueKey: string): string {
  return path.join(attachmentsRoot(stateRoot), issueSegment(issueKey));
}

export function legacyIssueAttachmentRoot(stateRoot: string, issueKey: string): string {
  return path.join(issueWorkspaceRoot(stateRoot, issueKey), ".issue-pilot", "attachments");
}

async function directories(root: string): Promise<string[]> {
  return readdir(root, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name), () => []);
}

export async function pruneState(stateRoot: string, issueKeys: string[]): Promise<void> {
  const active = new Set(issueKeys.map((key) => normalizeIssueKey(key).toLowerCase()));
  for (const category of ["workspaces", "sessions", "attachments"]) {
    const root = path.resolve(stateRoot, category);
    for (const entry of await directories(root)) {
      if (!active.has(entry.toLowerCase())) await rm(path.join(root, entry), { recursive: true, force: true });
    }
  }
  const repositoriesRoot = path.resolve(stateRoot, "repositories");
  for (const entry of await directories(repositoriesRoot)) {
    await execFileAsync("git", ["-C", path.join(repositoriesRoot, entry), "worktree", "prune", "--expire", "now"], { timeout: 30_000 });
  }
}
