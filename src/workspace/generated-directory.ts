import { rename, rm } from "node:fs/promises";

export interface GeneratedDirectoryOperations {
  rename(source: string, destination: string): Promise<void>;
  remove(directory: string): Promise<void>;
}

const directoryOperations: GeneratedDirectoryOperations = {
  rename,
  remove: (directory) => rm(directory, { recursive: true }),
};

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export class GeneratedDirectoryRollbackFailure extends Error {
  constructor(cause: unknown) {
    super("generated_directory_rollback_failed", { cause });
  }
}

export async function replaceGeneratedDirectory(
  target: string,
  replacement: string,
  previous: string,
  operations: GeneratedDirectoryOperations = directoryOperations,
): Promise<void> {
  let movedPrevious = false;
  try {
    await operations.rename(target, previous);
    movedPrevious = true;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  try {
    await operations.rename(replacement, target);
  } catch (error) {
    if (movedPrevious) {
      try { await operations.rename(previous, target); }
      catch (rollbackError) { throw new GeneratedDirectoryRollbackFailure(new AggregateError([error, rollbackError], "generated_directory_rollback_failed")); }
    }
    throw error;
  }

  if (movedPrevious) await operations.remove(previous).catch(() => undefined);
}
