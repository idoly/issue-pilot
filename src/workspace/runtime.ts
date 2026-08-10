import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";

import { issueRoot, issueRuntimeRoot, sharedCheckoutsRoot } from "./state.ts";

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
  const root = issueRoot(stateRoot, issueKey);
  const runtimeRoot = issueRuntimeRoot(stateRoot, issueKey);
  const temporaryRoot = path.join(root, `.runtime-${randomUUID()}`);
  const names = new Set<string>();

  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  try {
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    for (const repository of repositories) {
      if (!/^[a-z0-9._-]+$/.test(repository.name) || names.has(repository.name)) throw new Error("invalid_runtime_repository_name");
      names.add(repository.name);
      await symlink(path.relative(temporaryRoot, managedCheckout(stateRoot, repository.checkoutPath)), path.join(temporaryRoot, repository.name), "dir");
    }


    await rm(runtimeRoot, { recursive: true, force: true });
    await rename(temporaryRoot, runtimeRoot);
    return runtimeRoot;
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
