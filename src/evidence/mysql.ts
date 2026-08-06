import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function validateReadOnlyQuery(value: string): string {
  const statement = value.trim().replace(/;\s*$/, "");
  if (!statement || statement.length > 20_000) throw new Error("invalid_database_query");
  if (statement.includes(";") || /--|#|\/\*/.test(statement)) throw new Error("database_query_must_be_one_statement_without_comments");
  if (!/^(select|show|describe|desc|explain)\b/i.test(statement)) throw new Error("database_query_must_be_read_only");
  if (/\b(insert|update|delete|replace|create|alter|drop|truncate|rename|grant|revoke|call|do|handler|load|lock|unlock|set|use|begin|commit|rollback|savepoint|release)\b/i.test(statement)) throw new Error("database_query_must_be_read_only");
  if (/\binto\s+(?:out|dump)file\b|\binto\s+@|\bfor\s+update\b|\block\s+in\s+share\s+mode\b|\bprocedure\s+analyse\b|\b(?:sleep|benchmark|load_file|get_lock|release_lock|is_free_lock|is_used_lock|master_pos_wait|source_pos_wait|sys_exec|sys_eval)\s*\(/i.test(statement)) throw new Error("database_query_must_be_read_only");
  return statement;
}

function image(cwd: string): string {
  if (!/^issue-(?:[0-9]{4,}|[0-9]{8}-[0-9]{3,4})$/.test(path.basename(path.resolve(cwd)).toLowerCase())) throw new Error("issue_workspace_container_not_available");
  return process.env.PI_MYSQL_CLI_IMAGE ?? "docker.io/library/mysql:26.7.0";
}

function parseOutput(stdout: string) {
  const lines = stdout.replace(/\r/g, "").split("\n").filter(Boolean);
  const columns = (lines.shift() ?? "").split("\t");
  const rows = lines.map((line) => Object.fromEntries(columns.map((column, index) => [column, line.split("\t")[index] ?? ""])));
  return { columns, rows, truncated: false };
}

export async function queryMysql(pi: ExtensionAPI, cwd: string, input: { connectionUrl: string; statement: string }, signal?: AbortSignal) {
  const connection = new URL(input.connectionUrl);
  if (connection.protocol !== "mysql:" && connection.protocol !== "mariadb:") throw new Error("unsupported_mysql_connection_protocol");
  const database = decodeURIComponent(connection.pathname.replace(/^\//, ""));
  if (!connection.hostname || !connection.username || !database) throw new Error("invalid_mysql_connection_url");
  const password = decodeURIComponent(connection.password);
  if (/[\r\n]/.test(password)) throw new Error("invalid_mysql_password");
  const secretDirectory = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-mysql-"));
  try {
    const envFile = path.join(secretDirectory, "env");
    await writeFile(envFile, `MYSQL_PWD=${password}\n`, { mode: 0o600 });
    const execution = await pi.exec("podman", [
      "run", "--rm", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--read-only", "--tmpfs", "/tmp:size=64m,mode=1777",
      "--env-file", envFile, image(cwd), "mysql", "--batch", "--raw", "--connect-timeout=10", "--host", connection.hostname,
      "--port", connection.port || "3306", "--user", decodeURIComponent(connection.username), "--database", database,
      "--default-character-set=utf8mb4", "--execute", input.statement,
    ], { ...(signal ? { signal } : {}), timeout: 30_000 });
    if (execution.code !== 0) throw new Error("mysql_cli_query_failed");
    return { ...parseOutput(execution.stdout), runtime: "container" as const };
  } finally {
    await rm(secretDirectory, { recursive: true, force: true });
  }
}
