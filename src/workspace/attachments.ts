import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import type { openDatabase } from "../db/client.ts";
import { issueAttachments, issues } from "../db/schema.ts";
import { issueAttachmentRoot, issueWorkspaceRoot, legacyIssueAttachmentRoot } from "./state.ts";

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
    const legacyRoot = legacyIssueAttachmentRoot(stateRoot, issueKey);
    const source = path.resolve(attachment.objectKey);
    const destination = path.join(durableRoot, path.basename(source));
    if (path.dirname(source) === durableRoot) {
      await assertMatchingFile(source, attachment.size, attachment.sha256);
      await chmod(source, 0o600);
      continue;
    }
    if (path.dirname(source) !== legacyRoot) throw new Error("attachment_path_outside_managed_storage");

    await mkdir(durableRoot, { recursive: true, mode: 0o700 });
    await chmod(durableRoot, 0o700);
    const [sourceExists, destinationExists] = await Promise.all([exists(source), exists(destination)]);
    let moved = false;
    if (sourceExists && !destinationExists) {
      await rename(source, destination);
      moved = true;
    } else if (!sourceExists && !destinationExists) {
      throw new Error("attachment_file_missing");
    }
    await assertMatchingFile(destination, attachment.size, attachment.sha256);
    await chmod(destination, 0o600);
    try {
      await database.update(issueAttachments).set({ objectKey: destination }).where(and(eq(issueAttachments.id, attachment.id), eq(issueAttachments.objectKey, attachment.objectKey)));
    } catch (error) {
      if (moved) await rename(destination, source).catch(() => undefined);
      throw error;
    }
  }

  const issuesWithAttachments = new Map(rows.map(({ attachment, issueKey }) => [attachment.issueId, issueKey]));
  for (const [issueId, issueKey] of issuesWithAttachments) {
    if (await exists(issueWorkspaceRoot(stateRoot, issueKey))) await materializeWorkspaceAttachments(database, stateRoot, issueId, issueKey);
  }
}

export async function materializeWorkspaceAttachments(database: Database, stateRoot: string, issueId: string, issueKey: string): Promise<void> {
  const cacheRoot = legacyIssueAttachmentRoot(stateRoot, issueKey);
  const durableRoot = issueAttachmentRoot(stateRoot, issueKey);
  const attachments = await database.select().from(issueAttachments).where(eq(issueAttachments.issueId, issueId));
  await rm(cacheRoot, { recursive: true, force: true });
  if (!attachments.length) return;

  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await chmod(cacheRoot, 0o700);
  for (const attachment of attachments) {
    const source = path.resolve(attachment.objectKey);
    if (path.dirname(source) !== durableRoot) throw new Error("attachment_path_outside_managed_storage");
    await assertMatchingFile(source, attachment.size, attachment.sha256);
    const destination = path.join(cacheRoot, path.basename(source));
    await copyFile(source, destination);
    await chmod(destination, 0o400);
  }
}
