import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { normalizeIssueKey } from "../domain/issue-key.ts";

const execFileAsync = promisify(execFile);

async function directories(root: string): Promise<string[]> {
  return readdir(root, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name), () => []);
}

export async function pruneState(stateRoot: string, issueKeys: string[]): Promise<void> {
  const active = new Set(issueKeys.map((key) => normalizeIssueKey(key).toLowerCase()));
  for (const category of ["workspaces", "sessions"]) {
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
