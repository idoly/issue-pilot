import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { applicationConfig } from "../config.ts";
import * as schema from "./schema.ts";

export function openDatabase(file = applicationConfig.databaseFile) {
  const databasePath = path.resolve(file);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  closeSync(openSync(databasePath, "a", 0o600));
  chmodSync(databasePath, 0o600);

  const client = createClient({ url: `file:${databasePath}`, timeout: applicationConfig.state.sqliteBusyTimeoutMs });
  return {
    client,
    db: drizzle(client, { schema }),
    close: () => client.close(),
  };
}

export type DatabaseConnection = ReturnType<typeof openDatabase>;
export type Database = DatabaseConnection["db"];

/** Leave room for other bound values and stay below SQLite's variable limit. */
export async function readInBatches<Input, Row>(values: readonly Input[], select: (batch: Input[]) => PromiseLike<Row[]>): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; offset < values.length; offset += 500) {
    rows.push(...await select(values.slice(offset, offset + 500)));
  }
  return rows;
}
