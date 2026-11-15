import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";

import type { DatabaseConnection } from "../../src/db/client.ts";

/** Build the actual historical schema without attempting to undo later migrations. */
export async function migrateBefore(database: DatabaseConnection, folder: string, tag: string): Promise<void> {
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  assert.ok(index > 0, `Missing migration boundary: ${tag}`);
  const entries = journal.entries.slice(0, index);
  await mkdir(path.join(folder, "meta"), { recursive: true });
  await Promise.all([
    writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries })),
    ...entries.map((entry) => copyFile(`drizzle/${entry.tag}.sql`, path.join(folder, `${entry.tag}.sql`))),
  ]);
  await migrate(database.db, { migrationsFolder: folder });
}
