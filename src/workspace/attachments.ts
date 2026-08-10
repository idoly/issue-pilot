import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import type { openDatabase } from "../db/client.ts";
import { environments, issueAttachments, issues } from "../db/schema.ts";
import { assertManagedProjectWrappers, prepareProjectWrappers } from "./project-wrappers.ts";
import { ensureIssueWorkspaceLink, issueAttachmentRoot, issueRuntimeRoot, issueWorkspaceRoot, legacyIssueAttachmentStoreRoot, legacyWorkspaceAttachmentRoot } from "./state.ts";

type Database = ReturnType<typeof openDatabase>["db"];

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
}

async function assertMatchingFile(candidate: string, size: number, sha256: string): Promise<void> {
  const metadata = await stat(candidate);
  if (!metadata.isFile() || metadata.size !== size) throw new Error("attachment_migration_conflict");
  const digest = createHash("sha256").update(await readFile(candidate)).digest("hex");
  if (digest !== sha256) throw new Error("attachment_migration_conflict");
}

export async function migrateAttachmentStorage(database: Database, stateRoot: string): Promise<void> {
  const rows = await database.select({ attachment: issueAttachments, issueKey: issues.key })
    .from(issueAttachments)
    .innerJoin(issues, eq(issues.id, issueAttachments.issueId));

  for (const { attachment, issueKey } of rows) {
    const durableRoot = issueAttachmentRoot(stateRoot, issueKey);
    const source = path.resolve(attachment.objectKey);
    const destination = path.join(durableRoot, path.basename(source));
    if (path.dirname(source) === durableRoot) {
      await assertMatchingFile(source, attachment.size, attachment.sha256);
      await chmod(source, 0o400);
      continue;
    }
    const legacyRoots = new Set([legacyIssueAttachmentStoreRoot(stateRoot, issueKey), legacyWorkspaceAttachmentRoot(stateRoot, issueKey)]);
    if (!legacyRoots.has(path.dirname(source))) throw new Error("attachment_path_outside_managed_storage");

    await mkdir(durableRoot, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(path.dirname(durableRoot), 0o700), chmod(durableRoot, 0o700)]);
    const [sourceExists, destinationExists] = await Promise.all([exists(source), exists(destination)]);
    let moved = false;
    if (sourceExists && !destinationExists) {
      await rename(source, destination);
      moved = true;
    } else if (!sourceExists && !destinationExists) {
      throw new Error("attachment_file_missing");
    }
    await assertMatchingFile(destination, attachment.size, attachment.sha256);
    await chmod(destination, 0o400);
    try {
      await database.update(issueAttachments).set({ objectKey: destination }).where(and(eq(issueAttachments.id, attachment.id), eq(issueAttachments.objectKey, attachment.objectKey)));
    } catch (error) {
      if (moved) await rename(destination, source).catch(() => undefined);
      throw error;
    }
  }

  const issueKeys = new Set(rows.map(({ issueKey }) => issueKey));
  for (const issueKey of issueKeys) {
    await rmdir(legacyIssueAttachmentStoreRoot(stateRoot, issueKey)).catch((error) => {
      if (!(error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTEMPTY"].includes(String(error.code)))) throw error;
    });
  }
  await rmdir(path.resolve(stateRoot, "attachments")).catch((error) => {
    if (!(error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTEMPTY"].includes(String(error.code)))) throw error;
  });
}

export async function migrateDevelopmentRuntimeArtifacts(database: Database, stateRoot: string): Promise<{ prepared: string[]; migrated: string[]; blocked: Array<{ issueKey: string; reason: string }> }> {
  const developmentIssues = await database.select({ id: issues.id, key: issues.key }).from(issues)
    .innerJoin(environments, eq(environments.id, issues.environmentId))
    .where(eq(environments.kind, "dev"));
  const prepared: string[] = [];
  const migrated: string[] = [];
  const blocked: Array<{ issueKey: string; reason: string }> = [];

  for (const issue of developmentIssues) {
    const workspaceRoot = issueWorkspaceRoot(stateRoot, issue.key);
    if (!await exists(workspaceRoot)) continue;
    const metadataRoot = path.join(workspaceRoot, ".issue-pilot");
    let metadataEntries;
    try {
      metadataEntries = await readdir(metadataRoot, { withFileTypes: true });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        blocked.push({ issueKey: issue.key, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    try {
      for (const entry of metadataEntries ?? []) {
        if (!entry.isDirectory() || !["attachments", "bin"].includes(entry.name)) throw new Error("workspace_has_untracked_files");
      }
      const legacyAttachments = path.join(metadataRoot, "attachments");
      if (metadataEntries?.some((entry) => entry.name === "attachments")) {
        const attachments = await database.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id));
        const expected = new Map(attachments.map((attachment) => [path.basename(attachment.objectKey), attachment]));
        for (const entry of await readdir(legacyAttachments, { withFileTypes: true })) {
          const attachment = expected.get(entry.name);
          if (!entry.isFile() || !attachment) throw new Error("workspace_has_untracked_files");
          await assertMatchingFile(path.join(legacyAttachments, entry.name), attachment.size, attachment.sha256);
        }
      }
      if (metadataEntries?.some((entry) => entry.name === "bin")) await assertManagedProjectWrappers(path.join(metadataRoot, "bin"));

      await Promise.all([
        ensureIssueWorkspaceLink(stateRoot, issue.key),
        prepareProjectWrappers(issueRuntimeRoot(stateRoot, issue.key)),
      ]);
      prepared.push(issue.key);
      if (metadataEntries) {
        await rm(metadataRoot, { recursive: true });
        migrated.push(issue.key);
      }
    } catch (error) {
      blocked.push({ issueKey: issue.key, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { prepared, migrated, blocked };
}
