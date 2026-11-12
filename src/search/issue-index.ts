import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client, type InStatement } from "@libsql/client";
import { asc, eq, gt, inArray, sql } from "drizzle-orm";
import { readInBatches, type Database } from "../db/client.ts";
import { issues, subjects } from "../db/schema.ts";
import { EMBEDDING_BATCH_SIZE, EMBEDDING_DIMENSIONS, issueEmbeddings } from "./cloudflare.ts";
import type { IssueSearchHit, IssueSearchSettings } from "./contracts.ts";

const PAGE_SIZE = 256;
const CHUNK_BYTES = 7_000;
const documentFields = { id: issues.id, title: issues.title, description: issues.description };
const createVectors = `CREATE TABLE issue_vectors (
  issue_id TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  digest TEXT NOT NULL,
  embedding F32_BLOB(${EMBEDDING_DIMENSIONS}) NOT NULL CHECK(length(embedding) = ${EMBEDDING_DIMENSIONS * 4}),
  PRIMARY KEY (issue_id, chunk)
)`;

function document(row: { title: string; description: string }): string {
  return [row.title, row.description].join("\n\n").trim();
}

function splitDocument(text: string): string[] {
  const bytes = Buffer.from(text);
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; ) {
    let end = Math.min(start + CHUNK_BYTES, bytes.length);
    if (end < bytes.length) {
      const preferred = start + CHUNK_BYTES / 2;
      const newline = bytes.subarray(preferred, end).lastIndexOf(10);
      if (newline >= 0) end = preferred + newline + 1;
      else while ((bytes[end]! & 0xc0) === 0x80) end--;
    }
    const chunk = bytes.toString("utf8", start, end);
    if (chunk.trim()) chunks.push(chunk);
    start = end;
  }
  return chunks;
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

  private indexInfo() {
    return lstat(this.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  }

  private async openExisting(): Promise<Client | undefined> {
    const info = await this.indexInfo();
    if (!info) return undefined;
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new Error("invalid_issue_search_index");
    return createClient({ url: pathToFileURL(this.file).href, timeout: 5_000 });
  }

  private async publishFirstPage(statements: InStatement[], signal: AbortSignal, verify: () => Promise<void>): Promise<void> {
    const staged = `${this.file}.${randomUUID()}.tmp`;
    await (await open(staged, "ax", 0o600)).close();
    try {
      const client = createClient({ url: pathToFileURL(staged).href, timeout: 5_000 });
      try {
        await client.batch([createVectors, ...statements], "write");
      } finally {
        client.close();
      }
      await verify();
      // Refreshes are serialized under the API's state lease. Refuse an unexpected file.
      if (await this.indexInfo()) throw new Error("issue_search_index_already_exists");
      signal.throwIfAborted();
      await rename(staged, this.file);
    } catch (error) {
      await unlink(staged).catch((cleanup) => {
        throw new AggregateError([error, cleanup], "issue_search_index_cleanup_failed");
      });
      throw error;
    }
  }

  private async removeDeleted(client: Client, signal: AbortSignal, verify: () => Promise<void>): Promise<number> {
    const { rows } = await client.execute("SELECT DISTINCT issue_id FROM issue_vectors");
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
      const saved =
        existing && ids.length ? await existing.execute({ sql: `SELECT DISTINCT issue_id, digest FROM issue_vectors WHERE issue_id IN (${ids.map(() => "?").join(",")})`, args: ids }) : undefined;
      const indexed = new Map(saved?.rows.map((row) => [row.issue_id, row.digest]));
      let inspected = 0;
      let chunkCount = 0;
      const changed: Array<{ id: string; chunks: string[]; hash: string }> = [];
      for (const row of page) {
        const text = document(row);
        const hash = digest(text);
        if (indexed.get(row.id) !== hash) {
          const chunks = splitDocument(text);
          if (chunkCount && chunkCount + chunks.length > EMBEDDING_BATCH_SIZE) break;
          changed.push({ id: row.id, chunks, hash });
          chunkCount += chunks.length;
        }
        inspected++;
        if (chunkCount >= EMBEDDING_BATCH_SIZE) break;
      }
      if (changed.length || !existing) {
        const documents = changed.flatMap(({ chunks }) => chunks);
        const vectors: Buffer[] = [];
        // A document may span multiple provider batches; replace all its chunks atomically.
        for (let offset = 0; offset < documents.length; offset += EMBEDDING_BATCH_SIZE) {
          await verify();
          signal.throwIfAborted();
          vectors.push(...(await issueEmbeddings(settings, { documents: documents.slice(offset, offset + EMBEDDING_BATCH_SIZE) }, signal, this.fetchEmbeddings)));
        }
        await verify();
        signal.throwIfAborted();
        const statements: InStatement[] = [];
        let vectorIndex = 0;
        for (const row of changed) {
          statements.push({ sql: "DELETE FROM issue_vectors WHERE issue_id = ?", args: [row.id] });
          for (let chunk = 0; chunk < row.chunks.length; chunk++) {
            statements.push({ sql: "INSERT INTO issue_vectors (issue_id, chunk, digest, embedding) VALUES (?, ?, ?, ?)", args: [row.id, chunk, row.hash, vectors[vectorIndex++]!] });
          }
        }
        if (existing) await existing.batch(statements, "write");
        else await this.publishFirstPage(statements, signal, verify);
      }
      const removed = !after && existing ? await this.removeDeleted(existing, signal, verify) : 0;
      return { indexed: changed.length, removed, nextCursor: rows.length > inspected ? rows[inspected - 1]!.id : null };
    } finally {
      existing?.close();
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
      // Compute distances once. SQLite assigns consecutive rowids in SELECT order; only IDs/digests
      // are materialized, and closing this connection removes the temporary ranking.
      await client.execute({
        sql: "CREATE TEMP TABLE ranked_issues AS SELECT issue_id, digest FROM issue_vectors GROUP BY issue_id, digest ORDER BY MIN(vector_distance_cos(embedding, ?)), issue_id, digest",
        args: [vector!],
      });
      const hits: IssueSearchHit[] = [];
      let position = 0;
      while (hits.length < 10) {
        await verify();
        signal.throwIfAborted();
        const candidates = await client.execute({ sql: "SELECT rowid AS position, issue_id, digest FROM temp.ranked_issues WHERE rowid > ? ORDER BY rowid LIMIT 40", args: [position] });
        if (!candidates.rows.length) break;
        const rows = await this.database
          .select({ ...documentFields, key: issues.key, status: issues.status, assignee: sql<string | null>`coalesce(${subjects.displayName}, ${issues.assigneeSubject})` })
          .from(issues)
          .leftJoin(subjects, eq(subjects.subject, issues.assigneeSubject))
          .where(
            inArray(
              issues.id,
              candidates.rows.map((row) => String(row.issue_id)),
            ),
          );
        const current = new Map(rows.map((row) => [row.id, row]));
        for (const candidate of candidates.rows) {
          const issue = current.get(String(candidate.issue_id));
          if (issue && digest(document(issue)) === candidate.digest) hits.push({ key: issue.key, title: issue.title, status: issue.status, assignee: issue.assignee });
          if (hits.length === 10) break;
        }
        position = Number(candidates.rows.at(-1)!.position);
      }
      return hits;
    } finally {
      client.close();
    }
  }
}
