import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";

import { migrateDatabase } from "../../src/db/bootstrap.ts";
import { openDatabase } from "../../src/db/client.ts";
import * as schema from "../../src/db/schema.ts";

/**
 * Known, deliberate differences between the migrated database and schema.ts. Each entry must keep an explanation;
 * the test fails when an entry no longer matches so the list cannot silently outlive the difference.
 */
const KNOWN_DIFFERENCES = new Set([
  // Hand-written migrations kept these columns nullable; the issues_scope_required_* triggers (0009) reject
  // NULL scope, so schema.ts declares the enforced contract. Rebuilding the issues table is not worth the risk.
  "issues.service_id notNull: schema=true database=false",
  "issues.environment_id notNull: schema=true database=false",
]);

interface Shape {
  columns: string[];
  indexes: string[];
  foreignKeys: string[];
}

function declaredShape(table: SQLiteTable): Shape {
  const config = getTableConfig(table);
  const compositeKey = config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name));
  return {
    columns: config.columns
      .map((column) => {
        const primary = column.primary || compositeKey.includes(column.name);
        return `${column.name} type=${column.getSQLType().toLowerCase()} notNull=${column.notNull} primary=${primary}`;
      })
      .sort(),
    indexes: config.indexes
      .map(({ config: index }) => {
        const columns = index.columns.map((column) => ("name" in column ? column.name : "<expression>")).join(",");
        return `${index.name} unique=${index.unique} columns=${columns} partial=${index.where !== undefined}`;
      })
      .sort(),
    foreignKeys: config.foreignKeys
      .map((key) => {
        const reference = key.reference();
        const action = (value: string | undefined) => (value ?? "no action").toUpperCase();
        return `${reference.columns.map((column) => column.name).join(",")} -> ${getTableConfig(reference.foreignTable).name}(${reference.foreignColumns.map((column) => column.name).join(",")}) onUpdate=${action(key.onUpdate)} onDelete=${action(key.onDelete)}`;
      })
      .sort(),
  };
}

test("a freshly migrated database matches the tables, columns, indexes and foreign keys declared in schema.ts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-schema-drift-"));
  const database = openDatabase(path.join(root, "issues.db"));
  try {
    await migrateDatabase(database);
    const { client } = database;
    const declared = new Map((Object.values(schema) as unknown[]).filter((value): value is SQLiteTable => is(value, SQLiteTable)).map((table) => [getTableConfig(table).name, declaredShape(table)]));
    const actualTables = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name")).rows.map((row) =>
      String(row.name),
    );
    assert.deepEqual(actualTables, [...declared.keys()].sort(), "tables");

    const differences: string[] = [];
    for (const [table, expected] of declared) {
      const columns = (await client.execute(`PRAGMA table_info("${table}")`)).rows;
      const compositeKey = columns.filter((column) => Number(column.pk) > 0).length > 1;
      const actualColumns = new Map(
        columns.map((column) => [
          String(column.name),
          {
            type: String(column.type).toLowerCase(),
            // SQLite permits NULL in a non-INTEGER primary key unless NOT NULL is spelled out; drizzle reports every key column as notNull.
            notNull: Number(column.notnull) === 1 || (Number(column.pk) > 0 && (compositeKey || String(column.type).toLowerCase() === "integer")),
            primary: Number(column.pk) > 0,
          },
        ]),
      );
      const declaredColumns = new Map(
        expected.columns.map((line) => {
          const [name, type, notNull, primary] = line.split(" ");
          return [name!, { type: type!.slice(5), notNull: notNull === "notNull=true", primary: primary === "primary=true" }];
        }),
      );
      for (const name of new Set([...actualColumns.keys(), ...declaredColumns.keys()])) {
        const actual = actualColumns.get(name),
          wanted = declaredColumns.get(name);
        if (!actual || !wanted) {
          differences.push(`${table}.${name} present: schema=${Boolean(wanted)} database=${Boolean(actual)}`);
          continue;
        }
        for (const key of ["type", "notNull", "primary"] as const) if (actual[key] !== wanted[key]) differences.push(`${table}.${name} ${key}: schema=${wanted[key]} database=${actual[key]}`);
      }

      const indexes: string[] = [];
      for (const index of (await client.execute(`PRAGMA index_list("${table}")`)).rows) {
        if (index.origin !== "c") continue;
        const indexColumns = (await client.execute(`PRAGMA index_info("${String(index.name)}")`)).rows
          .sort((left, right) => Number(left.seqno) - Number(right.seqno))
          .map((column) => (column.name === null ? "<expression>" : String(column.name)));
        indexes.push(`${String(index.name)} unique=${Number(index.unique) === 1} columns=${indexColumns.join(",")} partial=${Number(index.partial) === 1}`);
      }
      indexes.sort();
      if (JSON.stringify(indexes) !== JSON.stringify(expected.indexes)) differences.push(`${table} indexes: schema=${JSON.stringify(expected.indexes)} database=${JSON.stringify(indexes)}`);

      const groups = new Map<number, Array<Record<string, unknown>>>();
      for (const row of (await client.execute(`PRAGMA foreign_key_list("${table}")`)).rows) groups.set(Number(row.id), [...(groups.get(Number(row.id)) ?? []), row]);
      const foreignKeys = [...groups.values()]
        .map((rows) => {
          rows.sort((left, right) => Number(left.seq) - Number(right.seq));
          const first = rows[0]!;
          return `${rows.map((row) => String(row.from)).join(",")} -> ${String(first.table)}(${rows.map((row) => String(row.to)).join(",")}) onUpdate=${String(first.on_update)} onDelete=${String(first.on_delete)}`;
        })
        .sort();
      if (JSON.stringify(foreignKeys) !== JSON.stringify(expected.foreignKeys))
        differences.push(`${table} foreign keys: schema=${JSON.stringify(expected.foreignKeys)} database=${JSON.stringify(foreignKeys)}`);
    }

    const unexpected = differences.filter((difference) => !KNOWN_DIFFERENCES.has(difference));
    assert.deepEqual(unexpected, [], "schema drift");
    assert.deepEqual(
      [...KNOWN_DIFFERENCES].filter((difference) => !differences.includes(difference)),
      [],
      "stale known differences",
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
