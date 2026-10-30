import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Database } from "../db/client.ts";
import { agentSessions, issues, issueWorkspaces } from "../db/schema.ts";
import { issueRoot } from "../workspace/state.ts";
import { createPrivateSessionManager } from "./pi-session.ts";

const resetEntry = "issue-pilot-session-reset";

async function readSession(file: string, root: string) {
  if (path.dirname(file) !== root || !path.basename(file).startsWith(".session-") || !(await lstat(file)).isFile()) throw new Error("agent_session_file_incomplete");
  const descriptor = await open(file, "r");
  try {
    const size = (await descriptor.stat()).size, tail = Buffer.alloc(1);
    if (!size) throw new Error("agent_session_file_incomplete");
    await descriptor.read(tail, 0, 1, size - 1);
    if (tail[0] !== 10) throw new Error("agent_session_file_incomplete");
  } finally { await descriptor.close(); }
  return SessionManager.open(file, root, root);
}

/** Caller holds the configuration scope and Issue reservation, and closes the active session first. */
export async function resetIssueSession(database: Database, stateRoot: string, issue: { id: string; key: string }, actor: string, expectedSessionId: string) {
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
    await database.transaction(async transaction => {
      await transaction.update(agentSessions).set({ sessionFile: file, workspacePath: root, updatedAt: new Date() }).where(eq(agentSessions.issueId, issue.id));
      await transaction.update(issues).set({ status: "open", updatedAt: new Date() }).where(eq(issues.id, issue.id));
      await transaction.update(issueWorkspaces).set({ status: "ready", lastError: null, updatedAt: new Date() }).where(and(eq(issueWorkspaces.issueId, issue.id), eq(issueWorkspaces.runtimeReady, true), inArray(issueWorkspaces.lastError, ["model_response_failed", "model_response_idle_timeout"])));
    });
  } catch (error) {
    try { await unlink(file); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "agent_session_reset_cleanup_failed"); }
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
    const manager = await readSession(file, root);
    history.push({ sessionId: manager.getSessionId(), createdAt: manager.getHeader()!.timestamp, current: history.length === 0, file });
    const reset = manager.getEntries().find(entry => entry.type === "custom" && entry.customType === resetEntry);
    const previousFile = reset?.type === "custom" ? (reset.data as { previousFile?: unknown })?.previousFile : undefined;
    if (previousFile === undefined) break;
    if (typeof previousFile !== "string" || path.basename(previousFile) !== previousFile) throw new Error("agent_session_history_invalid");
    file = path.join(root, previousFile);
  }
  return history;
}

export async function readIssueSessionHistory(database: Database, stateRoot: string, issue: { id: string; key: string }, sessionId: string) {
  const history = await issueSessionHistory(database, stateRoot, issue);
  const entry = history.find(item => item.sessionId === sessionId);
  if (!entry) throw new Error("agent_session_not_found");
  return readSession(entry.file, issueRoot(stateRoot, issue.key));
}
