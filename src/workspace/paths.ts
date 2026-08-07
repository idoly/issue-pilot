import path from "node:path";

import { normalizeIssueKey } from "../domain/issue-key.ts";

function issueSegment(issueKey: string): string {
  return normalizeIssueKey(issueKey).toLowerCase();
}

export function workspacesRoot(stateRoot: string): string {
  return path.resolve(stateRoot, "workspaces");
}

export function issueWorkspaceRoot(stateRoot: string, issueKey: string): string {
  return path.join(workspacesRoot(stateRoot), issueSegment(issueKey));
}

export function issueSessionRoot(stateRoot: string, issueKey: string): string {
  return path.resolve(stateRoot, "sessions", issueSegment(issueKey));
}

export function issueAttachmentRoot(stateRoot: string, issueKey: string): string {
  return path.join(issueWorkspaceRoot(stateRoot, issueKey), ".issue-pilot", "attachments");
}

export function toolsRoot(stateRoot: string): string {
  return path.resolve(stateRoot, "tools");
}
