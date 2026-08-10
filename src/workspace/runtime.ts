import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";

import { issueAttachmentRoot, issueRuntimeRoot, issueSessionRoot, sharedCheckoutsRoot } from "./state.ts";

export interface ReadOnlyRuntimeRepository {
  name: string;
  checkoutPath: string;
}

function managedCheckout(stateRoot: string, checkoutPath: string): string {
  const root = sharedCheckoutsRoot(stateRoot);
  const resolved = path.resolve(checkoutPath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("repository_checkout_outside_shared_root");
  return resolved;
}

export async function prepareReadOnlyRuntime(stateRoot: string, issueKey: string, repositories: ReadOnlyRuntimeRepository[]): Promise<string> {
  const sessionRoot = issueSessionRoot(stateRoot, issueKey);
  const runtimeRoot = issueRuntimeRoot(stateRoot, issueKey);
  const temporaryRoot = path.join(sessionRoot, `.runtime-${randomUUID()}`);
  const names = new Set<string>();

  await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
  await chmod(sessionRoot, 0o700);
  try {
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    for (const repository of repositories) {
      if (!/^[a-z0-9._-]+$/.test(repository.name) || names.has(repository.name)) throw new Error("invalid_runtime_repository_name");
      names.add(repository.name);
      await symlink(path.relative(temporaryRoot, managedCheckout(stateRoot, repository.checkoutPath)), path.join(temporaryRoot, repository.name), "dir");
    }

    const attachmentRoot = issueAttachmentRoot(stateRoot, issueKey);
    await mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
    await chmod(attachmentRoot, 0o700);
    await symlink(path.relative(temporaryRoot, attachmentRoot), path.join(temporaryRoot, "attachments"), "dir");

    await rm(runtimeRoot, { recursive: true, force: true });
    await rename(temporaryRoot, runtimeRoot);
    return runtimeRoot;
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
