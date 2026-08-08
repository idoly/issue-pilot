import { writeFile } from "node:fs/promises";

import { SessionManager } from "@earendil-works/pi-coding-agent";

export async function createPrivateSessionManager(cwd: string, sessionDirectory: string): Promise<SessionManager> {
  const manager = SessionManager.create(cwd, sessionDirectory);
  const sessionFile = manager.getSessionFile();
  const header = manager.getHeader();
  if (!sessionFile || !header) throw new Error("failed_to_initialize_agent_session");

  await writeFile(sessionFile, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  manager.setSessionFile(sessionFile);
  return manager;
}
