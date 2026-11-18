import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { assertSessionFileComplete, isIssueSessionPath } from "./pi-session.ts";

/**
 * One owner for opening a session file recorded in `agent_sessions`. Every reader (agent rounds, SSE,
 * history pages and inbound MCP) must apply the same binding rule and completeness check; Pi must also
 * resolve the file back to the recorded path, never to a replacement.
 */
export function assertBoundSessionPath(file: string, root: string): void {
  if (!isIssueSessionPath(file, root)) throw new Error("agent_session_file_incomplete");
}

export async function openBoundSession(file: string, root: string, cwd = root): Promise<SessionManager> {
  assertBoundSessionPath(file, root);
  await assertSessionFileComplete(file);
  const manager = SessionManager.open(file, root, cwd);
  if (manager.getSessionFile() !== path.resolve(file)) throw new Error("agent_session_file_incomplete");
  return manager;
}
