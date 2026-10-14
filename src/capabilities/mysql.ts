import { createConnection, type Connection, type ConnectionOptions, type FieldPacket, type QueryError, type RowDataPacket } from "mysql2";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilitySignal, capabilityTextResult } from "./contracts.ts";
import type { CapabilityConfig, CapabilityInputs } from "./registry.ts";
import type { IssueOutputStore, OutputAppender } from "../outputs/store.ts";
import { validateReadOnlySql } from "./sql.ts";

const limits = issuePilotConfig.limits.capability;

export function validateReadOnlyQuery(query: string): string {
  return validateReadOnlySql(query, limits.database.queryChars);
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
  const query = connection.query(statement);
  query.once("fields", (fields: FieldPacket[]) => { columns = fields.map((field) => field.name); });
  for await (const streamedRow of query.stream({ highWaterMark: 1 })) {
    const rowData = streamedRow as RowDataPacket;
    const record = Object.fromEntries(columns.map((column) => [column, rowData[column] ?? null]));
    rows.push(record);
  }
  return { columns, rows };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

async function exportedRows(connection: Connection, statement: string, format: "csv" | "jsonl", append: OutputAppender): Promise<{ columns: string[]; rows: number }> {
  let columns: string[] = [];
  let rows = 0;
  let headerWritten = false;
  const query = connection.query(statement);
  query.once("fields", (fields: FieldPacket[]) => { columns = fields.map((field) => field.name); });
  for await (const streamedRow of query.stream({ highWaterMark: 1 })) {
    const rowData = streamedRow as RowDataPacket;
    const record = Object.fromEntries(columns.map((column) => [column, rowData[column] ?? null]));
    if (format === "csv") {
      if (!headerWritten) { await append(`${columns.map(csvCell).join(",")}\n`); headerWritten = true; }
      await append(`${columns.map((column) => csvCell(record[column])).join(",")}\n`);
    } else await append(`${JSON.stringify(record)}\n`);
    rows += 1;
  }
  if (format === "csv" && !headerWritten && columns.length) await append(`${columns.map(csvCell).join(",")}\n`);
  return { columns, rows };
}

type MysqlDatabaseConfig = CapabilityConfig<"db">["databases"][number];

export async function queryMysql(input: { config: MysqlDatabaseConfig; statement: string }, signal?: AbortSignal, connectionFactory: MysqlConnectionFactory = createConnection) {
  const connectionUrl = new URL(input.config.url);
  const database = decodeURIComponent(connectionUrl.pathname.slice(1));
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
      port: Number(connectionUrl.port),
      user: input.config.username,
      password: input.config.password,
      database,
      charset: "utf8mb4",
      connectTimeout: limits.connectionMs,
      multipleStatements: false,
      rowsAsArray: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      typeCast: (field) => field.string(),
    });
    if (activeSignal.aborted) throw activeSignal.reason;
    await execute(connection, "START TRANSACTION READ ONLY");
    const result = await streamedRows(connection, input.statement);
    if (activeSignal.aborted) throw activeSignal.reason;
    await execute(connection, "ROLLBACK");
    return { ...result, runtime: "node" as const };
  } catch (error) {
    if (connection && !destroyed) await execute(connection, "ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    activeSignal.removeEventListener("abort", abort);
    if (connection && !destroyed) await end(connection);
  }
}

export async function exportMysql(input: { config: MysqlDatabaseConfig; statement: string; output: { fileName: string; format: "csv" | "jsonl" }; store: IssueOutputStore }, signal?: AbortSignal, connectionFactory: MysqlConnectionFactory = createConnection) {
  const connectionUrl = new URL(input.config.url);
  const database = decodeURIComponent(connectionUrl.pathname.slice(1));
  let connection: Connection | undefined;
  let destroyed = false;
  let transactionActive = false;
  const activeSignal = capabilitySignal(signal);
  const abort = () => { destroyed = true; connection?.destroy(); };
  activeSignal.addEventListener("abort", abort, { once: true });
  try {
    if (activeSignal.aborted) throw activeSignal.reason;
    connection = await connectionFactory({
      host: connectionUrl.hostname,
      port: Number(connectionUrl.port),
      user: input.config.username,
      password: input.config.password,
      database,
      charset: "utf8mb4",
      connectTimeout: limits.connectionMs,
      multipleStatements: false,
      rowsAsArray: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      typeCast: (field) => field.string(),
    });
    if (activeSignal.aborted) throw activeSignal.reason;
    await execute(connection, "START TRANSACTION READ ONLY");
    transactionActive = true;
    const output = await input.store.generate(input.output.fileName, async (append) => {
      const result = await exportedRows(connection!, input.statement, input.output.format, append);
      if (activeSignal.aborted) throw activeSignal.reason;
      await execute(connection!, "ROLLBACK");
      transactionActive = false;
      return result;
    });
    return { fileName: output.fileName, format: input.output.format, size: output.size, columns: output.result.columns, rows: output.result.rows, runtime: "node" as const };
  } catch (error) {
    if (connection && !destroyed && transactionActive) await execute(connection, "ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    activeSignal.removeEventListener("abort", abort);
    if (connection && !destroyed) await end(connection);
  }
}

export async function readMysql(config: CapabilityConfig<"db">, input: CapabilityInputs["db"], signal?: AbortSignal, outputStore?: IssueOutputStore, connectionFactory?: MysqlConnectionFactory) {
  const database = config.databases.find(({ url }) => decodeURIComponent(new URL(url).pathname.slice(1)) === input.database);
  if (!database) throw new Error("db_database_not_authorized");
  const statement = validateReadOnlyQuery(input.statement);
  if (input.output) {
    if (!outputStore) throw new Error("issue_output_not_available");
    const exported = await exportMysql({ config: database, statement, output: input.output, store: outputStore }, signal, connectionFactory);
    return capabilityTextResult(JSON.stringify({ provider: "mysql", output: exported }, null, 2), { provider: "mysql", fileName: exported.fileName, rows: exported.rows });
  }
  const queryResult = await queryMysql({ config: database, statement }, signal, connectionFactory);
  return capabilityTextResult(JSON.stringify({ provider: "mysql", ...queryResult }, null, 2), { provider: "mysql" });
}
