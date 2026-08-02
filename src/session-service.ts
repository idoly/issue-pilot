import { access, mkdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { IssueStore } from "./store.ts";

export class IssueSessionService {
  private readonly store: IssueStore;
  private readonly sessionsRoot: string;
  private readonly managers = new Map<string, SessionManager>();

  constructor(store: IssueStore, stateRoot: string) {
    this.store = store;
    this.sessionsRoot = resolve(stateRoot, "sessions");
  }

  async openOrCreate(issueId: string, workspacePath: string): Promise<SessionManager> {
    const key = issueId.trim().toLowerCase();
    const active = this.managers.get(key);
    if (active) return active;

    const issue = await this.store.get(issueId);
    if (!issue) throw new Error(`issue not found: ${issueId}`);

    if (issue.agentSession && await this.fileExists(issue.agentSession.sessionFile)) {
      this.assertManagedSessionPath(issue.agentSession.sessionFile);
      const manager = SessionManager.open(
        issue.agentSession.sessionFile,
        resolve(this.sessionsRoot, issue.id),
        issue.agentSession.workspacePath,
      );
      this.managers.set(key, manager);
      return manager;
    }

    const absoluteWorkspace = resolve(workspacePath);
    const sessionDir = resolve(this.sessionsRoot, issue.id);
    await mkdir(absoluteWorkspace, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    const manager = SessionManager.create(absoluteWorkspace, sessionDir);
    manager.appendSessionInfo(`${issue.id}: ${issue.title}`);
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error(`failed to create persistent session for ${issue.id}`);

    const binding = await this.store.bindAgentSession(issue.id, {
      sessionId: manager.getSessionId(),
      sessionFile,
      workspacePath: absoluteWorkspace,
    }, "system", Boolean(issue.agentSession));

    if (binding.sessionFile !== sessionFile) {
      await rm(sessionFile, { force: true });
      this.assertManagedSessionPath(binding.sessionFile);
      const resumed = SessionManager.open(binding.sessionFile, sessionDir, binding.workspacePath);
      this.managers.set(key, resumed);
      return resumed;
    }
    this.managers.set(key, manager);
    return manager;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private assertManagedSessionPath(filePath: string): void {
    const absolute = resolve(filePath);
    const pathFromRoot = relative(this.sessionsRoot, absolute);
    if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
      throw new Error(`refusing session file outside managed root: ${filePath}`);
    }
  }
}

export class IssueRunCoordinator {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(issueId: string, operation: () => Promise<T>): Promise<T> {
    const key = issueId.trim().toLowerCase();
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.tails.set(key, current);
    try {
      return await current;
    } finally {
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}
