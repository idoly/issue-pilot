import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, openSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { ApplicationStateLease } from "../src/state-lease.ts";

/** Keys removed from service_deployments.config by migration 0082. */
const RETIRED_DEPLOYMENT_KEYS = ["nacos", "db", "redis", "mq", "es", "mcpServices"] as const;

const RETIRED_COLUMNS: Record<string, readonly string[]> = {
  user_credentials: ["model_api_keys"],
  application_settings: ["mysql_stdio", "max_concurrent_issues"],
};

export interface RetiredSecretsExport {
  format: "issue-pilot-retired-secrets-v1";
  sourceDatabase: string;
  exportedAt: string;
  applicationSettings: {
    maxConcurrentIssues: unknown;
    mysqlStdio: unknown;
  };
  users: Array<{ subject: string; modelApiKeys: unknown; updatedAt: string | null }>;
  deployments: Array<{ id: string; serviceId: string; environmentId: string; retiredConfig: Record<string, unknown>; updatedAt: string | null }>;
}

export interface ExportRetiredSecretsOptions {
  /** Existing, stopped database or an isolated checkpoint copy; never the live WAL main file alone. */
  databasePath: string;
  outputPath: string;
  /** Asserts that databasePath is an isolated checkpoint copy and no application lease is needed. */
  checkpointCopy: boolean;
  now?: Date;
}

export interface ExportRetiredSecretsResult {
  outputPath: string;
  users: number;
  deployments: number;
}

function absoluteRegularFile(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (resolved !== value) throw new Error(`${label} must be an absolute path`);
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} must be a regular file, not a symlink`);
  return resolved;
}

function assertPrivateDirectory(directory: string): void {
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("output_parent_must_be_directory");
  if (process.getuid && metadata.uid !== process.getuid()) throw new Error("output_parent_must_be_owned_by_current_user");
  if ((metadata.mode & 0o7777) !== 0o700) throw new Error("output_parent_must_be_private_0700");
}

/** Preserve exact historical evidence: keep the raw text when a JSON column is malformed. */
function decodeJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0 && !["{}", "null"].includes(value.trim());
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function assertRetiredColumns(database: DatabaseSync): void {
  for (const [table, columns] of Object.entries(RETIRED_COLUMNS)) {
    const names = new Set(
      database
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => String(row.name)),
    );
    if (columns.some((column) => !names.has(column))) throw new Error(`retired_secret_columns_missing: ${table} already migrated`);
  }
}

function writePrivateJson(outputPath: string, payload: RetiredSecretsExport): void {
  let created = false;
  try {
    const descriptor = openSync(outputPath, "wx", 0o600);
    created = true;
    try {
      // openSync mode is masked by the umask; fchmod makes the final mode deterministic.
      fchmodSync(descriptor, 0o600);
      writeSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (created) rmSync(outputPath, { force: true });
    throw error;
  }
}

/** Read retired secrets from a stopped database or checkpoint copy and publish a private JSON evidence file. */
export async function exportRetiredSecrets(options: ExportRetiredSecretsOptions): Promise<ExportRetiredSecretsResult> {
  const databasePath = absoluteRegularFile(options.databasePath, "database");
  if (options.checkpointCopy) for (const suffix of ["-wal", "-shm"] as const) if (existsSync(databasePath + suffix)) throw new Error(`checkpoint_copy_has_sidecar: ${suffix}`);
  const outputPath = path.resolve(options.outputPath);
  if (outputPath !== options.outputPath) throw new Error("output must be an absolute path");
  assertPrivateDirectory(path.dirname(outputPath));

  const lease = options.checkpointCopy ? undefined : new ApplicationStateLease(path.dirname(databasePath));
  await lease?.start();
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assertRetiredColumns(database);
      const settings = database.prepare("SELECT max_concurrent_issues, mysql_stdio FROM application_settings WHERE id = 1").get() as
        | { max_concurrent_issues?: unknown; mysql_stdio?: unknown }
        | undefined;
      const users = database
        .prepare("SELECT subject, model_api_keys, updated_at FROM user_credentials ORDER BY subject")
        .all()
        .map((row) => ({ subject: String(row.subject), modelApiKeys: decodeJson(row.model_api_keys), updatedAt: timestamp(row.updated_at) }))
        .filter((row) => hasContent(row.modelApiKeys));
      const deployments = database
        .prepare("SELECT id, service_id, environment_id, config, updated_at FROM service_deployments ORDER BY id")
        .all()
        .map((row) => {
          const config = decodeJson(row.config);
          const retiredConfig =
            config && typeof config === "object" && !Array.isArray(config)
              ? Object.fromEntries(
                  RETIRED_DEPLOYMENT_KEYS.filter((key) => Object.hasOwn(config as Record<string, unknown>, key)).map((key): [string, unknown] => [key, (config as Record<string, unknown>)[key]]),
                )
              : {};
          return {
            id: String(row.id),
            serviceId: String(row.service_id),
            environmentId: String(row.environment_id),
            retiredConfig,
            updatedAt: timestamp(row.updated_at),
          };
        })
        .filter((row) => Object.keys(row.retiredConfig).length > 0);

      const payload: RetiredSecretsExport = {
        format: "issue-pilot-retired-secrets-v1",
        sourceDatabase: databasePath,
        exportedAt: (options.now ?? new Date()).toISOString(),
        applicationSettings: {
          maxConcurrentIssues: settings?.max_concurrent_issues ?? null,
          mysqlStdio: decodeJson(settings?.mysql_stdio),
        },
        users,
        deployments,
      };
      writePrivateJson(outputPath, payload);
      return { outputPath, users: users.length, deployments: deployments.length };
    } finally {
      database.close();
    }
  } finally {
    await lease?.close();
  }
}

function argument(value: string | undefined, label: string): string {
  if (!value) throw new Error(`missing_${label}`);
  return value;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: { database: { type: "string" }, output: { type: "string" }, "checkpoint-copy": { type: "boolean" } },
    });
    const result = await exportRetiredSecrets({
      databasePath: argument(values.database, "database"),
      outputPath: argument(values.output, "output"),
      checkpointCopy: values["checkpoint-copy"] === true,
    });
    // Counts only: never print retired values.
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
