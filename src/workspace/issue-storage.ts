import type { Dirent } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import type { openDatabase } from "../db/client.ts";
import { agentSessions, issues } from "../db/schema.ts";
import { backupsRoot, issueAgentRoot, issueRuntimeRoot, legacyIssueSessionRoot } from "./state.ts";

type Database = ReturnType<typeof openDatabase>["db"];

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function managedAgentFile(name: string): boolean {
  return name.endsWith(".jsonl") || name.endsWith(".runtime.json");
}

async function assertSameFile(left: string, right: string): Promise<void> {
  const [leftMetadata, rightMetadata] = await Promise.all([stat(left), stat(right)]);
  if (!leftMetadata.isFile() || !rightMetadata.isFile() || leftMetadata.size !== rightMetadata.size) throw new Error("agent_session_migration_conflict");
  const [leftContent, rightContent] = await Promise.all([readFile(left), readFile(right)]);
  if (!leftContent.equals(rightContent)) throw new Error("agent_session_migration_conflict");
}

export async function migrateDatabaseBackups(stateRoot: string): Promise<string[]> {
  const entries = await readdir(stateRoot, { withFileTypes: true }).catch((error) => {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  });
  const candidates = entries.filter((entry) => entry.name.startsWith("issues.db."));
  if (!candidates.length) return [];
  if (candidates.some((entry) => !entry.isFile())) throw new Error("backup_storage_has_untracked_file");
  const destinationRoot = backupsRoot(stateRoot);
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  await chmod(destinationRoot, 0o700);
  for (const entry of candidates) {
    const source = path.join(stateRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    try {
      await stat(destination);
      await assertSameFile(source, destination);
      await rm(source);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      await rename(source, destination);
    }
    await chmod(destination, 0o600);
  }
  return candidates.map((entry) => entry.name).sort();
}

export async function migrateIssueSessionStorage(
  database: Database,
  stateRoot: string,
): Promise<{ migrated: string[]; blocked: Array<{ issueKey: string; reason: string }> }> {
  const rows = await database.select({
    issueId: issues.id,
    issueKey: issues.key,
    sessionFile: agentSessions.sessionFile,
    workspacePath: agentSessions.workspacePath,
  }).from(issues).leftJoin(agentSessions, eq(agentSessions.issueId, issues.id));
  const migrated: string[] = [];
  const blocked: Array<{ issueKey: string; reason: string }> = [];

  for (const row of rows) {
    const legacyRoot = legacyIssueSessionRoot(stateRoot, row.issueKey);
    const agentRoot = issueAgentRoot(stateRoot, row.issueKey);
    const oldRuntimeRoot = path.join(legacyRoot, "runtime");
    const newRuntimeRoot = issueRuntimeRoot(stateRoot, row.issueKey);
    let entries: Dirent[] | undefined;
    try {
      entries = await readdir(legacyRoot, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        blocked.push({ issueKey: row.issueKey, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }

    const sessionInLegacyRoot = row.sessionFile ? path.dirname(path.resolve(row.sessionFile)) === legacyRoot : false;
    if (!entries && !sessionInLegacyRoot) continue;
    const moved: Array<{ source: string; destination: string }> = [];
    try {
      for (const entry of entries ?? []) {
        const managedRuntime = entry.isDirectory() && entry.name === "runtime";
        if (!managedRuntime && (!entry.isFile() || !managedAgentFile(entry.name))) throw new Error("issue_storage_has_untracked_files");
      }

      const files = (entries ?? []).filter((entry) => entry.isFile());
      if (files.length || sessionInLegacyRoot) {
        await mkdir(agentRoot, { recursive: true, mode: 0o700 });
        await Promise.all([chmod(path.dirname(agentRoot), 0o700), chmod(agentRoot, 0o700)]);
      }
      for (const entry of files) {
        const source = path.join(legacyRoot, entry.name);
        const destination = path.join(agentRoot, entry.name);
        try {
          await stat(destination);
          await assertSameFile(source, destination);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
          await rename(source, destination);
          moved.push({ source, destination });
        }
        await chmod(destination, 0o600);
      }

      const nextSessionFile = sessionInLegacyRoot ? path.join(agentRoot, path.basename(row.sessionFile!)) : row.sessionFile;
      if (sessionInLegacyRoot) await stat(nextSessionFile!);
      const nextWorkspacePath = row.workspacePath && path.resolve(row.workspacePath) === oldRuntimeRoot ? newRuntimeRoot : row.workspacePath;
      if (nextSessionFile !== row.sessionFile || nextWorkspacePath !== row.workspacePath) {
        await database.transaction(async (transaction) => {
          await transaction.update(agentSessions).set({
            sessionFile: nextSessionFile!,
            workspacePath: nextWorkspacePath!,
            updatedAt: new Date(),
          }).where(eq(agentSessions.issueId, row.issueId));
        });
      }

      if (entries) {
        await rm(legacyRoot, { recursive: true }).catch((error) => {
          blocked.push({ issueKey: row.issueKey, reason: error instanceof Error ? error.message : String(error) });
        });
      }
      migrated.push(row.issueKey);
    } catch (error) {
      for (const file of moved.reverse()) await rename(file.destination, file.source).catch(() => undefined);
      blocked.push({ issueKey: row.issueKey, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  await rmdir(path.resolve(stateRoot, "sessions")).catch((error) => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errorCode(error) ?? "")) throw error;
  });
  return { migrated, blocked };
}
