import { createHash } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { asc, gt, inArray, sql } from "drizzle-orm";
import { readInBatches, type Database } from "../db/client.ts";
import { issues } from "../db/schema.ts";
import { EMBEDDING_BATCH_SIZE, EMBEDDING_DIMENSIONS, issueEmbeddings } from "./cloudflare.ts";
import type { IssueSearchHit, IssueSearchSettings } from "./contracts.ts";

const PAGE_SIZE = 256;
const MAX_DESCRIPTION_CHARACTERS = 4_000;
const description = sql<string>`substr(${issues.description}, 1, ${MAX_DESCRIPTION_CHARACTERS})`;
const documentFields = { id: issues.id, title: issues.title, description };

function document(row: { title: string; description: string }): string {
  return Buffer.from([row.title, row.description].join("\n\n").trim()).subarray(0, 7_000).toString("utf8");
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class IssueSearchIndexRequired extends Error {
  constructor() {
    super("issue_search_index_required");
  }
}

/** The file is derived from SQLite and is only opened by explicit refreshes or searches. */
export class IssueSearchIndex {
  private readonly file: string;
  private readonly database: Database;
  private readonly fetchEmbeddings: typeof fetch;

  constructor(database: Database, stateRoot: string, fetchEmbeddings: typeof fetch) {
    this.database = database;
    this.fetchEmbeddings = fetchEmbeddings;
    this.file = join(stateRoot, "vectors.db");
  }

  private async openExisting(): Promise<Client | undefined> {
    const info = await lstat(this.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return undefined;
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new Error("invalid_issue_search_index");
    return createClient({ url: pathToFileURL(this.file).href, timeout: 5_000 });
  }

  private async create(): Promise<Client> {
    await (await open(this.file, "ax", 0o600)).close();
    let client: Client | undefined;
    try {
      client = createClient({ url: pathToFileURL(this.file).href, timeout: 5_000 });
      await client.execute(
        `CREATE TABLE issue_vectors (issue_id TEXT PRIMARY KEY, digest TEXT NOT NULL, embedding F32_BLOB(${EMBEDDING_DIMENSIONS}) NOT NULL CHECK(length(embedding) = ${EMBEDDING_DIMENSIONS * 4}))`,
      );
      return client;
    } catch (error) {
      client?.close();
      await unlink(this.file).catch((cleanup) => {
        throw new AggregateError([error, cleanup], "issue_search_index_cleanup_failed");
      });
      throw error;
    }
  }

  private async removeDeleted(client: Client, signal: AbortSignal, verify: () => Promise<void>): Promise<number> {
    const { rows } = await client.execute("SELECT issue_id FROM issue_vectors");
    const ids = rows.map((row) => String(row.issue_id));
    const live = new Set(await readInBatches(ids, (batch) => this.database.select({ id: issues.id }).from(issues).where(inArray(issues.id, batch))).then((rows) => rows.map(({ id }) => id)));
    const deleted = ids.filter((id) => !live.has(id));
    if (!deleted.length) return 0;
    await verify();
    signal.throwIfAborted();
    for (let i = 0; i < deleted.length; i += PAGE_SIZE) {
      signal.throwIfAborted();
      const args = deleted.slice(i, i + PAGE_SIZE);
      await client.execute({ sql: `DELETE FROM issue_vectors WHERE issue_id IN (${args.map(() => "?").join(",")})`, args });
    }
    return deleted.length;
  }

  async refresh(settings: IssueSearchSettings, after: string | undefined, signal: AbortSignal, verify: () => Promise<void>) {
    const existing = await this.openExisting();
    let client = existing;
    try {
      if (after && !existing) throw new IssueSearchIndexRequired();
      const rows = await this.database
        .select(documentFields)
        .from(issues)
        .where(after ? gt(issues.id, after) : undefined)
        .orderBy(asc(issues.id))
        .limit(PAGE_SIZE + 1);
      const page = rows.slice(0, PAGE_SIZE);
      const ids = page.map(({ id }) => id);
      const saved = existing && ids.length ? await existing.execute({ sql: `SELECT issue_id, digest FROM issue_vectors WHERE issue_id IN (${ids.map(() => "?").join(",")})`, args: ids }) : undefined;
      const indexed = new Map(saved?.rows.map((row) => [row.issue_id, row.digest]));
      let inspected = 0;
      const changed: Array<{ id: string; text: string; hash: string }> = [];
      for (const row of page) {
        inspected++;
        const text = document(row);
        const hash = digest(text);
        if (indexed.get(row.id) !== hash) changed.push({ id: row.id, text, hash });
        if (changed.length === EMBEDDING_BATCH_SIZE) break;
      }
      if (changed.length || !existing) {
        await verify();
        signal.throwIfAborted();
        const vectors = changed.length ? await issueEmbeddings(settings, { documents: changed.map(({ text }) => text) }, signal, this.fetchEmbeddings) : [];
        if (changed.length) await verify();
        signal.throwIfAborted();
        client ??= await this.create();
        signal.throwIfAborted();
        if (changed.length)
          await client.batch(
            changed.map((row, index) => ({
              sql: "INSERT INTO issue_vectors VALUES (?, ?, ?) ON CONFLICT (issue_id) DO UPDATE SET digest = excluded.digest, embedding = excluded.embedding",
              args: [row.id, row.hash, vectors[index]!],
            })),
            "write",
          );
      }
      const removed = !after && existing ? await this.removeDeleted(existing, signal, verify) : 0;
      return { indexed: changed.length, removed, nextCursor: rows.length > inspected ? rows[inspected - 1]!.id : null };
    } finally {
      client?.close();
    }
  }

  async search(settings: IssueSearchSettings, query: string, signal: AbortSignal, verify: () => Promise<void>): Promise<IssueSearchHit[]> {
    const client = await this.openExisting();
    if (!client) throw new IssueSearchIndexRequired();
    try {
      if (!(await client.execute("SELECT 1 FROM issue_vectors LIMIT 1")).rows.length) return [];
      await verify();
      signal.throwIfAborted();
      const [vector] = await issueEmbeddings(settings, { query }, signal, this.fetchEmbeddings);
      signal.throwIfAborted();
      // One bounded candidate read. Edits/deletions since the last refresh can reduce the number returned.
      const candidates = await client.execute({
        sql: "SELECT issue_id, digest FROM issue_vectors ORDER BY vector_distance_cos(embedding, ?), issue_id LIMIT 40",
        args: [vector!],
      });
      if (!candidates.rows.length) return [];
      const rows = await this.database
        .select({ ...documentFields, key: issues.key, status: issues.status })
        .from(issues)
        .where(
          inArray(
            issues.id,
            candidates.rows.map((row) => String(row.issue_id)),
          ),
        );
      const current = new Map(rows.map((row) => [row.id, row]));
      const hits: IssueSearchHit[] = [];
      for (const candidate of candidates.rows) {
        const issue = current.get(String(candidate.issue_id));
        if (issue && digest(document(issue)) === candidate.digest) hits.push({ key: issue.key, title: issue.title, status: issue.status });
        if (hits.length === 10) break;
      }
      return hits;
    } finally {
      client.close();
    }
  }
}
