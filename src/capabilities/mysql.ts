import { createConnection, type Connection, type ConnectionOptions, type FieldPacket, type QueryError, type RowDataPacket } from "mysql2";

import { capabilitySignal, MAX_CAPABILITY_RESULT_BYTES, MAX_DATABASE_QUERY_CHARS, MAX_DATABASE_ROWS } from "./contracts.ts";

export function validateReadOnlyQuery(value: string): string {
  const statement = value.trim().replace(/;\s*$/, "");
  if (!statement || statement.length > MAX_DATABASE_QUERY_CHARS) throw new Error("invalid_database_query");
  if (statement.includes(";") || /--|#|\/\*/.test(statement)) throw new Error("database_query_must_be_one_statement_without_comments");
  if (!/^(select|show|describe|desc|explain)\b/i.test(statement)) throw new Error("database_query_must_be_read_only");
  if (/\b(insert|update|delete|replace|create|alter|drop|truncate|rename|grant|revoke|call|do|handler|load|lock|unlock|set|use|begin|commit|rollback|savepoint|release)\b/i.test(statement)) throw new Error("database_query_must_be_read_only");
  if (/\binto\s+(?:out|dump)file\b|\binto\s+@|\bfor\s+update\b|\block\s+in\s+share\s+mode\b|\bprocedure\s+analyse\b|\b(?:sleep|benchmark|load_file|get_lock|release_lock|is_free_lock|is_used_lock|master_pos_wait|source_pos_wait|sys_exec|sys_eval)\s*\(/i.test(statement)) throw new Error("database_query_must_be_read_only");
  return statement;
}

export type MysqlConnectionFactory = (options: ConnectionOptions) => Connection | Promise<Connection>;

function execute(connection: Connection, statement: string): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.query(statement, (error) => error ? reject(error) : resolve());
  });
}

function end(connection: Connection): Promise<void> {
  return new Promise((resolve, reject) => connection.end((error?: QueryError | null) => error ? reject(error) : resolve()));
}

async function streamedRows(connection: Connection, statement: string): Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }> {
  let columns: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  let bytes = 2;
  const query = connection.query(statement);
  query.once("fields", (fields: FieldPacket[]) => { columns = fields.map((field) => field.name); });
  for await (const value of query.stream({ highWaterMark: 1 })) {
    if (rows.length >= MAX_DATABASE_ROWS) throw new Error("capability_result_too_large");
    const row = value as RowDataPacket;
    const normalized = Object.fromEntries(columns.map((column) => [column, row[column] ?? null]));
    bytes += Buffer.byteLength(JSON.stringify(normalized)) + (rows.length ? 1 : 0);
    if (bytes > MAX_CAPABILITY_RESULT_BYTES) throw new Error("capability_result_too_large");
    rows.push(normalized);
  }
  return { columns, rows };
}

export async function queryMysql(input: { connectionUrl: string; statement: string }, signal?: AbortSignal, connectionFactory: MysqlConnectionFactory = createConnection) {
  const connectionUrl = new URL(input.connectionUrl);
  if (connectionUrl.protocol !== "mysql:") throw new Error("unsupported_mysql_connection_protocol");
  const database = decodeURIComponent(connectionUrl.pathname.replace(/^\//, ""));
  if (!connectionUrl.hostname || !connectionUrl.port || !connectionUrl.username || !/^\/[^/]+$/.test(connectionUrl.pathname) || !database || database.includes("/")) throw new Error("invalid_mysql_connection_url");
  const password = decodeURIComponent(connectionUrl.password);
  if (/[\r\n]/.test(password)) throw new Error("invalid_mysql_password");

  let connection: Connection | undefined;
  let destroyed = false;
  const activeSignal = capabilitySignal(signal);
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
    await execute(connection, "START TRANSACTION READ ONLY");
    const output = await streamedRows(connection, input.statement);
    if (activeSignal.aborted) throw activeSignal.reason;
    await execute(connection, "ROLLBACK");
    return { ...output, runtime: "node" as const };
  } catch (error) {
    if (connection && !destroyed) await execute(connection, "ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    activeSignal.removeEventListener("abort", abort);
    if (connection && !destroyed) await end(connection);
  }
}
