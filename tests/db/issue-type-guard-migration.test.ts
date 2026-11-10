import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase } from "../../src/db/client.ts";
import { environments, serviceDeployments, services, subjects } from "../../src/db/schema.ts";

test("enforces the Issue type enum without rebuilding the table or trusting the retired default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-type-guard-")),
    folder = path.join(root, "migrations");
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const previous = {
    ...journal,
    entries: journal.entries.slice(
      0,
      journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0070_issue_type_guard"),
    ),
  };
  await mkdir(path.join(folder, "meta"), { recursive: true });
  await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(previous));
  for (const { tag } of previous.entries) await copyFile(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
  const db = openDatabase(path.join(root, "issues.db"));
  try {
    await migrate(db.db, { migrationsFolder: folder });
    await db.db.insert(subjects).values({ subject: "owner" });
    const [environment] = await db.db.insert(environments).values({ key: "prod", name: "Prod", kind: "prod" }).returning();
    const [service] = await db.db.insert(services).values({ key: "orders", name: "Orders", description: "" }).returning();
    await db.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
    // A pre-migration row written with the retired table default must block the upgrade instead of being coerced.
    await db.client.execute({
      sql: "INSERT INTO issues (id,key,title,type,service_id,environment_id,reporter_subject,created_at,updated_at) VALUES ('i1','ISSUE-20261105-001','Legacy','request',?,?,'owner',0,0)",
      args: [service!.id, environment!.id],
    });
    await assert.rejects(migrate(db.db, { migrationsFolder: path.resolve("drizzle") }), /CHECK constraint failed/);

    await db.client.execute("UPDATE issues SET type = 'smart_analysis' WHERE id = 'i1'");
    await db.client.execute("INSERT INTO issue_workspaces (issue_id,status,created_at,updated_at) VALUES ('i1','not_created',0,0)");
    await migrate(db.db, { migrationsFolder: path.resolve("drizzle") });
    await assert.rejects(
      db.client.execute({
        sql: "INSERT INTO issues (id,key,title,type,service_id,environment_id,reporter_subject,created_at,updated_at) VALUES ('i2','ISSUE-20261105-002','Invalid','request',?,?,'owner',0,0)",
        args: [service!.id, environment!.id],
      }),
      /invalid_issue_type/,
    );
    // The table default is still the retired value, so an insert that omits the type now fails loudly.
    await assert.rejects(
      db.client.execute({
        sql: "INSERT INTO issues (id,key,title,service_id,environment_id,reporter_subject,created_at,updated_at) VALUES ('i3','ISSUE-20261105-003','Defaulted',?,?,'owner',0,0)",
        args: [service!.id, environment!.id],
      }),
      /invalid_issue_type/,
    );
    await assert.rejects(db.client.execute("UPDATE issues SET type = 'request' WHERE id = 'i1'"), /invalid_issue_type/);
    assert.equal((await db.client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok");
    assert.equal((await db.client.execute("PRAGMA foreign_key_check")).rows.length, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
