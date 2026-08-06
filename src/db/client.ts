import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "./schema.ts";

export function openDatabase(file = process.env.ISSUE_PILOT_DATABASE ?? ".issue-pilot/issues.db") {
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

export type Database = ReturnType<typeof openDatabase>["db"];
