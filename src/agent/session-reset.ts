import { agentMessageReceipt, type AgentMessageRequest } from "./message-delivery.ts";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Database } from "../db/client.ts";
import { agentSessions, issues, issueWorkspaces } from "../db/schema.ts";
import { assertIssueRoot, issueRoot } from "../workspace/state.ts";
import { assertSessionFileComplete, createPrivateSessionManager, isIssueSessionPath, openRegularSessionFile } from "./pi-session.ts";

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
  if (!isIssueSessionPath(file, root)) throw new Error("agent_session_file_incomplete");
  await ownSessionFile(() => assertSessionFileComplete(file));
  return ownSessionFile(async () => SessionManager.open(file, root, root));
}

/**
 * Creation writes the reset link immediately after the header. Stop at that first entry;
 * listing history must not scan every tool result or treat later conversation content as a link.
 */
async function readSessionSummary(file: string, root: string) {
  if (!isIssueSessionPath(file, root)) throw new Error("agent_session_file_incomplete");
  const { descriptor } = await ownSessionFile(() => openRegularSessionFile(file));
  try {
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
    return { ...header, previousFile };
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
  const previous = await readSession(binding.sessionFile, root);
  if (previous.getSessionId() !== expectedSessionId) throw new Error("agent_session_changed");
  const manager = await createPrivateSessionManager(root, root);
  const file = manager.getSessionFile()!;
  try {
    // A custom entry is audit metadata, never model context. The old JSONL stays byte-for-byte intact.
    manager.appendCustomEntry(resetEntry, { previousFile: path.basename(binding.sessionFile), actor, resetAt: new Date().toISOString() });
    await database.transaction(async (transaction) => {
      await edit?.(transaction);
      await transaction.update(agentSessions).set({ sessionFile: file, workspacePath: root, updatedAt: new Date() }).where(eq(agentSessions.issueId, issue.id));
      await transaction.update(issues).set({ status: "open", updatedAt: new Date() }).where(eq(issues.id, issue.id));
      await transaction
        .update(issueWorkspaces)
        .set({ status: "ready", lastError: null, updatedAt: new Date() })
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
  const history: Array<{ sessionId: string; createdAt: string; current: boolean; file: string }> = [];
  while (file) {
    if (seen.has(file)) throw new Error("agent_session_history_invalid");
    seen.add(file);
    const { sessionId, createdAt, previousFile } = await readSessionSummary(file, root);
    history.push({ sessionId, createdAt, current: history.length === 0, file });
    if (previousFile === undefined) break;
    if (typeof previousFile !== "string" || path.basename(previousFile) !== previousFile) throw new Error("agent_session_history_invalid");
    file = path.join(root, previousFile);
  }
  return history;
}

export async function readIssueSessionHistory(database: Database, stateRoot: string, issue: { id: string; key: string }, sessionId: string) {
  const history = await issueSessionHistory(database, stateRoot, issue);
  const entry = history.find((item) => item.sessionId === sessionId);
  if (!entry) throw new Error("agent_session_not_found");
  return readSession(entry.file, issueRoot(stateRoot, issue.key));
}

/** Receipt lookup follows the same validated reset chain as history, including compacted branches. */
export async function readIssueMessageReceipt(database: Database, stateRoot: string, issue: { id: string; key: string }, request: AgentMessageRequest, current?: SessionManager) {
  await assertIssueRoot(stateRoot, issue.key);
  if (current) {
    const file = current.getSessionFile();
    if (!file || !isIssueSessionPath(file, issueRoot(stateRoot, issue.key))) throw new Error("agent_session_file_incomplete");
    await ownSessionFile(() => assertSessionFileComplete(file));
    const receipt = agentMessageReceipt(current, request);
    if (receipt) return receipt;
  }
  for (const entry of await issueSessionHistory(database, stateRoot, issue)) {
    if (current?.getSessionId() === entry.sessionId) continue;
    const receipt = agentMessageReceipt(await readSession(entry.file, issueRoot(stateRoot, issue.key)), request);
    if (receipt) return receipt;
  }
  return undefined;
}
