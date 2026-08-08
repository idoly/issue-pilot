import { createConnection, type Connection, type ConnectionOptions, type FieldPacket, type RowDataPacket } from "mysql2/promise";

import { MAX_CAPABILITY_RESULT_BYTES, MAX_DATABASE_ROWS } from "./limits.ts";

export function validateReadOnlyQuery(value: string): string {
  const statement = value.trim().replace(/;\s*$/, "");
  if (!statement || statement.length > 20_000) throw new Error("invalid_database_query");
  if (statement.includes(";") || /--|#|\/\*/.test(statement)) throw new Error("database_query_must_be_one_statement_without_comments");
  if (!/^(select|show|describe|desc|explain)\b/i.test(statement)) throw new Error("database_query_must_be_read_only");
  if (/\b(insert|update|delete|replace|create|alter|drop|truncate|rename|grant|revoke|call|do|handler|load|lock|unlock|set|use|begin|commit|rollback|savepoint|release)\b/i.test(statement)) throw new Error("database_query_must_be_read_only");
  if (/\binto\s+(?:out|dump)file\b|\binto\s+@|\bfor\s+update\b|\block\s+in\s+share\s+mode\b|\bprocedure\s+analyse\b|\b(?:sleep|benchmark|load_file|get_lock|release_lock|is_free_lock|is_used_lock|master_pos_wait|source_pos_wait|sys_exec|sys_eval)\s*\(/i.test(statement)) throw new Error("database_query_must_be_read_only");
  return statement;
}

export type MysqlConnectionFactory = (options: ConnectionOptions) => Promise<Connection>;

export async function queryMysql(input: { connectionUrl: string; statement: string }, signal?: AbortSignal, connectionFactory: MysqlConnectionFactory = createConnection) {
  const connectionUrl = new URL(input.connectionUrl);
  if (connectionUrl.protocol !== "mysql:") throw new Error("unsupported_mysql_connection_protocol");
  const database = decodeURIComponent(connectionUrl.pathname.replace(/^\//, ""));
  if (!connectionUrl.hostname || !connectionUrl.username || !database) throw new Error("invalid_mysql_connection_url");
  const password = decodeURIComponent(connectionUrl.password);
  if (/[\r\n]/.test(password)) throw new Error("invalid_mysql_password");

  let connection: Connection | undefined;
  let destroyed = false;
  const activeSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const abort = () => {
    destroyed = true;
    connection?.destroy();
  };
  activeSignal.addEventListener("abort", abort, { once: true });
  try {
    if (activeSignal.aborted) throw activeSignal.reason;
    connection = await connectionFactory({
      host: connectionUrl.hostname,
      port: Number(connectionUrl.port || 3306),
      user: decodeURIComponent(connectionUrl.username),
      password,
      database,
      charset: "utf8mb4",
      connectTimeout: 10_000,
      multipleStatements: false,
      rowsAsArray: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      typeCast: (field) => field.string(),
    });
    if (activeSignal.aborted) throw activeSignal.reason;
    const [result, fields] = await connection.query<RowDataPacket[]>(input.statement);
    if (activeSignal.aborted) throw activeSignal.reason;
    if (!Array.isArray(result)) throw new Error("mysql_query_did_not_return_rows");
    const columns = (fields as FieldPacket[]).map((field) => field.name);
    if (result.length > MAX_DATABASE_ROWS) throw new Error("capability_result_too_large");
    const rows = result.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
    if (Buffer.byteLength(JSON.stringify(rows)) > MAX_CAPABILITY_RESULT_BYTES) throw new Error("capability_result_too_large");
    return { columns, rows, runtime: "node" as const };
  } finally {
    activeSignal.removeEventListener("abort", abort);
    if (connection && !destroyed) await connection.end();
  }
}
