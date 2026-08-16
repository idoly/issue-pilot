import { createConnection, type Connection, type ConnectionOptions, type FieldPacket, type QueryError, type RowDataPacket } from "mysql2";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilityResultText, capabilitySignal, capabilityTextResult } from "./contracts.ts";
import type { CapabilityConfig, CapabilityInputs } from "./registry.ts";
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
  let bytes = 2;
  const query = connection.query(statement);
  query.once("fields", (fields: FieldPacket[]) => { columns = fields.map((field) => field.name); });
  for await (const streamedRow of query.stream({ highWaterMark: 1 })) {
    if (rows.length >= limits.database.rows) throw new Error("capability_result_too_large");
    const rowData = streamedRow as RowDataPacket;
    const record = Object.fromEntries(columns.map((column) => [column, rowData[column] ?? null]));
    bytes += Buffer.byteLength(JSON.stringify(record)) + (rows.length ? 1 : 0);
    if (bytes > limits.resultBytes) throw new Error("capability_result_too_large");
    rows.push(record);
  }
  return { columns, rows };
}

export async function queryMysql(input: { config: CapabilityConfig<"db">; statement: string }, signal?: AbortSignal, connectionFactory: MysqlConnectionFactory = createConnection) {
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

export async function readMysql(config: CapabilityConfig<"db">, input: CapabilityInputs["db"], signal?: AbortSignal) {
  const queryResult = await queryMysql({ config, statement: validateReadOnlyQuery(input.statement) }, signal);
  return capabilityTextResult(capabilityResultText({ provider: "mysql", ...queryResult }), { provider: "mysql" });
}
