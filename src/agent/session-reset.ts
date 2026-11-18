import { agentMessageReceipt, type AgentMessageRequest } from "./message-delivery.ts";
import { stat, unlink, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Database } from "../db/client.ts";
import { agentSessions, issues, issueWorkspaces } from "../db/schema.ts";
import { assertIssueRoot, issueRoot } from "../workspace/state.ts";
import { assertSessionFileComplete, createPrivateSessionManager, openRegularSessionFile, syncSessionFile } from "./pi-session.ts";
import { assertBoundSessionPath, openBoundSession } from "./session-file.ts";
import { DomainError } from "../domain/errors.ts";

const resetEntry = "issue-pilot-session-reset";

/** A bound session file that disappeared is a stable condition, not an internal error. */
async function ownSessionFile<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT" || code === "ENOTDIR") throw new Error("agent_session_file_missing", { cause: error });
    throw error;
  }
}

async function readSession(file: string, root: string) {
  return ownSessionFile(() => openBoundSession(file, root));
}

/**
 * Creation writes the reset link immediately after the header. Stop at that first entry;
 * listing history must not scan every tool result or treat later conversation content as a link.
 */
async function readSessionSummary(file: string, root: string) {
  assertBoundSessionPath(file, root);
  const { descriptor, metadata } = await ownSessionFile(() => openRegularSessionFile(file));
  try {
    // A crash inside Pi's append can leave an unterminated final record. Listing needs only the header,
    // so record that damage for display instead of failing here; full transcript reads still refuse it.
    const tail = Buffer.alloc(1);
    const { bytesRead } = await descriptor.read(tail, 0, 1, metadata.size - 1);
    const incomplete = bytesRead !== 1 || tail[0] !== 0x0a;
    let header: { sessionId: string; createdAt: string } | undefined;
    let previousFile: string | undefined;
    for await (const line of descriptor.readLines({ encoding: "utf8", autoClose: false, start: 0 })) {
      if (!line.trim()) continue;
      if (header && !line.includes(resetEntry)) break;
      let record: unknown;
      try {
        record = JSON.parse(line.replace(/^\uFEFF/, ""));
      } catch {
        throw new Error("agent_session_file_incomplete");
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("agent_session_file_incomplete");
      const value = record as { type?: unknown; id?: unknown; timestamp?: unknown; customType?: unknown; data?: unknown };
      if (!header) {
        if (value.type !== "session" || typeof value.id !== "string" || typeof value.timestamp !== "string") throw new Error("agent_session_file_incomplete");
        header = { sessionId: value.id, createdAt: value.timestamp };
        continue;
      }
      if (value.type === "custom" && value.customType === resetEntry) {
        const data = value.data && typeof value.data === "object" && !Array.isArray(value.data) ? (value.data as { previousFile?: unknown }) : {};
        if (data.previousFile !== undefined) {
          if (typeof data.previousFile !== "string") throw new Error("agent_session_history_invalid");
          previousFile = data.previousFile;
        }
      }
      break;
    }
    if (!header) throw new Error("agent_session_file_incomplete");
    return { ...header, previousFile, incomplete };
  } finally {
    await descriptor.close();
  }
}

/** Caller holds the configuration scope and Issue reservation, and closes the active session first. */
export async function resetIssueSession(
  database: Database,
  stateRoot: string,
  issue: { id: string; key: string },
  actor: string,
  expectedSessionId: string,
  edit?: (transaction: Parameters<Parameters<Database["transaction"]>[0]>[0]) => Promise<void>,
) {
  const root = issueRoot(stateRoot, issue.key);
  const [binding] = await database.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)).limit(1);
  if (!binding) throw new Error("agent_session_not_found");
  // Reset is the escape hatch for a transcript whose tail was cut off by ENOSPC/OOM/SIGKILL. Verify only
  // the header identity; a full parse would refuse the damaged file forever. The old file stays untouched.
  const previous = await readSessionSummary(binding.sessionFile, root);
  if (previous.sessionId !== expectedSessionId) throw new Error("agent_session_changed");
  const manager = await createPrivateSessionManager(root, root);
  const file = manager.getSessionFile()!;
  try {
    // A custom entry is audit metadata, never model context. The old JSONL stays byte-for-byte intact.
    manager.appendCustomEntry(resetEntry, { previousFile: path.basename(binding.sessionFile), actor, resetAt: new Date().toISOString() });
    // The binding below commits with FULL sync; make the new transcript durable first.
    await syncSessionFile(file);
    await database.transaction(async (transaction) => {
      await edit?.(transaction);
      await transaction.update(agentSessions).set({ sessionFile: file, workspacePath: root, updatedAt: new Date() }).where(eq(agentSessions.issueId, issue.id));
      await transaction.update(issues).set({ status: "open", updatedAt: new Date() }).where(eq(issues.id, issue.id));
      await transaction
        .update(issueWorkspaces)
        .set({ status: "ready", releasedAt: null, lastError: null, updatedAt: new Date() })
        .where(and(eq(issueWorkspaces.issueId, issue.id), eq(issueWorkspaces.runtimeReady, true), inArray(issueWorkspaces.lastError, ["model_response_failed", "model_response_idle_timeout"])));
    });
  } catch (error) {
    try {
      await unlink(file);
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "agent_session_reset_cleanup_failed");
    }
    throw error;
  }
  return { sessionId: manager.getSessionId() };
}

/** Follow only application-written reset links, never a client-provided filesystem path. */
export async function issueSessionHistory(database: Database, stateRoot: string, issue: { id: string; key: string }) {
  const root = issueRoot(stateRoot, issue.key);
  const [binding] = await database.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)).limit(1);
  if (!binding) return [];
  let file: string | undefined = binding.sessionFile;
  const seen = new Set<string>();
  const history: Array<{ sessionId: string; createdAt: string; current: boolean; incomplete: boolean; file: string }> = [];
  while (file) {
    if (seen.has(file)) throw new Error("agent_session_history_invalid");
    seen.add(file);
    const { sessionId, createdAt, previousFile, incomplete } = await readSessionSummary(file, root);
    history.push({ sessionId, createdAt, current: history.length === 0, incomplete, file });
    if (previousFile === undefined) break;
    if (typeof previousFile !== "string" || path.basename(previousFile) !== previousFile) throw new Error("agent_session_history_invalid");
    file = path.join(root, previousFile);
  }
  return history;
}

export async function readIssueSessionHistory(database: Database, stateRoot: string, issue: { id: string; key: string }, sessionId: string) {
  const history = await issueSessionHistory(database, stateRoot, issue);
  const entry = history.find((item) => item.sessionId === sessionId);
  if (!entry) throw new DomainError("agent_session_not_found", "not_found");
  return readSession(entry.file, issueRoot(stateRoot, issue.key));
}

type ReceiptEntry = { type: string; id?: unknown; customType?: unknown; data?: unknown };

/** agentMessageReceipt reads only admission and delivery-transition entries; retain nothing else. */
function receiptEntries(entries: Iterable<{ type: string; id?: unknown; customType?: unknown; data?: unknown }>): ReceiptEntry[] {
  const retained: ReceiptEntry[] = [];
  for (const entry of entries)
    if (entry.type === "custom" && (entry.customType === "issue-pilot-user" || entry.customType === "issue-pilot-user-delivery"))
      retained.push({ type: "custom", id: entry.id, customType: entry.customType, data: entry.data });
  return retained;
}

/** Only a cut-off final append is recoverable here. Never open this file through Pi or rewrite it. */
async function readArchivedReceiptEntries(descriptor: FileHandle, size: number, sessionId: string): Promise<ReceiptEntry[]> {
  const tail = Buffer.alloc(1);
  const { bytesRead } = await descriptor.read(tail, 0, 1, size - 1);
  const unterminated = bytesRead === 1 && tail[0] !== 0x0a;
  const entries: Array<{ type: string; id?: unknown; customType?: unknown; data?: unknown }> = [];
  let header = false;
  let invalid = false;
  for await (const raw of descriptor.readLines({ encoding: "utf8", autoClose: false, start: 0 })) {
    if (invalid) throw new Error("agent_session_file_incomplete");
    if (!raw.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(header ? raw : raw.replace(/^\uFEFF/, ""));
    } catch {
      if (!unterminated || !header) throw new Error("agent_session_file_incomplete");
      invalid = true;
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("agent_session_file_incomplete");
    const entry = record as { type?: unknown; id?: unknown; customType?: unknown; data?: unknown };
    if (!header) {
      if (entry.type !== "session" || entry.id !== sessionId) throw new Error("agent_session_file_incomplete");
      header = true;
    } else if (entry.type === "custom") entries.push({ ...entry, type: "custom" });
  }
  if (!header) throw new Error("agent_session_file_incomplete");
  return receiptEntries(entries);
}

type FileIdentity = Pick<Stats, "dev" | "ino" | "size" | "mtimeMs">;
interface CachedReceiptIndex extends FileIdentity {
  sessionId: string;
  recoverable: boolean;
  entries: ReceiptEntry[];
  bytes: number;
}

const receiptCacheFiles = 128;
const receiptCacheBytes = 16 * 1024 * 1024;
let receiptCacheTotal = 0;
/**
 * Archived (reset) generations are never appended to, yet prod/test sessions retire every round, so each
 * admission with a request ID would otherwise reparse every archived transcript. Keep only their admission and
 * transition entries, keyed by path and file identity; any change in identity reparses. LRU by insertion order.
 */
const receiptCache = new Map<string, CachedReceiptIndex>();

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function forgetReceiptIndex(file: string): void {
  const cached = receiptCache.get(file);
  if (!cached) return;
  receiptCache.delete(file);
  receiptCacheTotal -= cached.bytes;
}

function rememberReceiptIndex(file: string, value: CachedReceiptIndex): void {
  forgetReceiptIndex(file);
  if (value.bytes > receiptCacheBytes) return;
  receiptCache.set(file, value);
  receiptCacheTotal += value.bytes;
  for (const [oldest, cached] of receiptCache) {
    if (receiptCache.size <= receiptCacheFiles && receiptCacheTotal <= receiptCacheBytes) break;
    receiptCache.delete(oldest);
    receiptCacheTotal -= cached.bytes;
  }
}

/** Test seam: the number of archived generations whose receipt index is retained. */
export function cachedReceiptIndexCount(): number {
  return receiptCache.size;
}

/** Receipt entries of an archived generation, parsed once per file identity with the same validation as before. */
async function archivedReceiptEntries(file: string, root: string, sessionId: string, recoverable: boolean): Promise<ReceiptEntry[]> {
  const { descriptor, metadata } = await ownSessionFile(() => openRegularSessionFile(file));
  const before = identityOf(metadata);
  try {
    const cached = receiptCache.get(file);
    if (cached && cached.sessionId === sessionId && cached.recoverable === recoverable && sameIdentity(cached, metadata)) {
      receiptCache.delete(file);
      receiptCache.set(file, cached);
      return cached.entries;
    }
    forgetReceiptIndex(file);
    if (recoverable) {
      const entries = await readArchivedReceiptEntries(descriptor, metadata.size, sessionId);
      rememberReceiptIndex(file, { ...before, sessionId, recoverable, entries, bytes: Buffer.byteLength(JSON.stringify(entries)) });
      return entries;
    }
  } finally {
    await descriptor.close();
  }
  const manager = await readSession(file, root);
  const entries = receiptEntries(manager.getEntries());
  // Pi may migrate an old format while opening it; cache only when the file kept the identity it was read with.
  const after = await ownSessionFile(() => stat(file));
  if (manager.getSessionId() === sessionId && sameIdentity(before, after))
    rememberReceiptIndex(file, { ...identityOf(after), sessionId, recoverable, entries, bytes: Buffer.byteLength(JSON.stringify(entries)) });
  return entries;
}

function identityOf(metadata: FileIdentity): FileIdentity {
  return { dev: metadata.dev, ino: metadata.ino, size: metadata.size, mtimeMs: metadata.mtimeMs };
}

/** Search every validated reset generation. A partial last append cannot erase a complete admission record. */
export async function readIssueMessageReceipt(
  database: Database,
  stateRoot: string,
  issue: { id: string; key: string },
  request: AgentMessageRequest,
  current?: SessionManager,
  options: { forAdmission?: boolean } = {},
) {
  const root = issueRoot(stateRoot, issue.key);
  await assertIssueRoot(stateRoot, issue.key);
  if (current) {
    const file = current.getSessionFile();
    assertBoundSessionPath(file ?? "", root);
    await ownSessionFile(() => assertSessionFileComplete(file!));
    const receipt = agentMessageReceipt(current.getEntries(), request);
    if (receipt) return receipt;
  }
  let incomplete = false;
  for (const entry of await issueSessionHistory(database, stateRoot, issue)) {
    if (current?.getSessionId() === entry.sessionId) continue;
    const recoverable = !entry.current && entry.incomplete;
    // The bound (current) file still receives appends; only archived generations use the index cache.
    const receipt = entry.current
      ? agentMessageReceipt((await readSession(entry.file, root)).getEntries(), request)
      : agentMessageReceipt(await archivedReceiptEntries(entry.file, root, entry.sessionId, recoverable), request);
    if (receipt) return receipt;
    incomplete ||= recoverable;
  }
  // A lookup must not tell an uncertain client its input was absent. A new admission can still
  // proceed: a partial append could not have completed before dispatch.
  if (incomplete && !options.forAdmission) throw new Error("agent_session_file_incomplete");
  return undefined;
}
