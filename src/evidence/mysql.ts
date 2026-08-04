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
  if (/\binto\s+(?:out|dump)file\b|\bfor\s+update\b|\block\s+in\s+share\s+mode\b|\b(?:sleep|benchmark)\s*\(/i.test(statement)) throw new Error("database_query_must_be_read_only");
  if (/^select\b/i.test(statement)) {
    const limits = [...statement.matchAll(/\blimit\s+(?:(\d+)\s*,\s*)?(\d+)\b/gi)];
    const maximumRows = Number(limits.at(-1)?.[2]);
    if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 1000) throw new Error("database_select_requires_limit_at_most_1000");
  }
  return statement;
}

function image(cwd: string): string {
  if (!/^issue-(?:[0-9]{4,}|[0-9]{8}-[0-9]{3,4})$/.test(path.basename(path.resolve(cwd)).toLowerCase())) throw new Error("issue_workspace_container_not_available");
  return process.env.PI_MYSQL_CLI_IMAGE ?? "docker.io/library/mysql:26.7.0";
}

function parseOutput(stdout: string) {
  const lines = stdout.replace(/\r/g, "").split("\n").filter(Boolean);
  const columns = (lines.shift() ?? "").split("\t").slice(0, 50).map((column) => column.slice(0, 100));
  const rows: Array<Record<string, string>> = [];
  let budget = 40 * 1024;
  let truncated = lines.length > 100 || Buffer.byteLength(stdout, "utf8") > 50 * 1024;
  for (const line of lines.slice(0, 100)) {
    const values = line.split("\t");
    const row: Record<string, string> = {};
    for (const [index, column] of columns.entries()) {
      const raw = values[index] ?? "";
      const allowance = Math.max(0, Math.min(2000, budget - Buffer.byteLength(column, "utf8") - 16));
      const value = Buffer.from(raw).subarray(0, allowance).toString("utf8");
      row[column] = value;
      budget -= Buffer.byteLength(column) + Buffer.byteLength(value) + 16;
      if (budget <= 0) { truncated = true; break; }
    }
    rows.push(row);
    if (budget <= 0) break;
  }
  return { columns, rows, truncated };
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
