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

  const client = createClient({ url: `file:${databasePath}` });
  return {
    client,
    db: drizzle(client, { schema }),
    close: () => client.close(),
  };
}

export type DatabaseConnection = ReturnType<typeof openDatabase>;
export type Database = DatabaseConnection["db"];
