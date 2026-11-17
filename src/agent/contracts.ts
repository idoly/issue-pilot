import type { ImageContent } from "@earendil-works/pi-ai";

import type { AgentRunState } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import type { AgentMessageRequest } from "./message-delivery.ts";
import type { GitCommitIdentity } from "./pi-session.ts";

export interface AgentReservation {
  enqueue(issueId: string, message?: string): void;
  closeSession(issueId: string): Promise<void>;
}

/** The Issue already has a reservation, queued round or abort in progress. */
export class AgentBusyError extends DomainError {
  constructor() {
    super("issue_already_running", "conflict");
    this.name = "AgentBusyError";
  }
}

export interface AgentController {
  messageReceipt(issue: { id: string; key: string }, request: AgentMessageRequest, authorize: () => Promise<unknown>): Promise<{ state: string }>;
  enqueue(issueId: string, message?: string): void;
  send(issueId: string, message: string, gitIdentity?: GitCommitIdentity, images?: ImageContent[], authorize?: () => Promise<unknown>, request?: AgentMessageRequest): Promise<void>;
  isRunning(issueId: string): boolean;
  getRunState(issueId: string): AgentRunState;
  runExclusive<T>(issueIds: string[], operation: (reservation: AgentReservation) => Promise<T>): Promise<T>;
  /** Mark live sessions that read a changed Issue's evidence so they re-prepare on their next round; never reserves. */
  markScopeChanged?(issueIds: Iterable<string>): void;
  abort(issueId: string, authorize?: () => Promise<unknown>): Promise<void>;
  setMaxConcurrentIssues(maxConcurrentIssues: number): void;
  close?(): Promise<void>;
}
