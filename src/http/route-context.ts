import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { issuePilotConfig } from "../../issue-pilot.config.ts";

import type { AgentController } from "../agent/engine.ts";
import type { AgentEventBus } from "../agent/events.ts";
import type { Database, DatabaseConnection } from "../db/client.ts";
import { issues, subjects } from "../db/schema.ts";
import { parseIssueKey } from "../domain/contracts.ts";
import type { AgentModelCatalog } from "../pi/models.ts";
import type { WorkspaceLifecycleManager } from "../workspace/lifecycle.ts";
import { ApiError } from "./input.ts";

export interface ApiRouteContext {
  app: FastifyInstance;
  database: DatabaseConnection;
  engine: AgentController;
  stateRoot: string;
  modelCatalog: AgentModelCatalog;
  events: AgentEventBus;
  workspaces: WorkspaceLifecycleManager;
}

export function serializePerson(person: typeof subjects.$inferSelect) {
  return { subject: person.subject, name: person.displayName ?? person.username ?? person.subject, email: person.email ?? "" };
}

export async function ensureCurrentSubject(database: ApiRouteContext["database"]): Promise<string> {
  const subject = issuePilotConfig.subject;
  await database.db.insert(subjects).values({ subject, username: subject, displayName: subject, email: "" }).onConflictDoNothing();
  return subject;
}

export async function requireIssue(database: ApiRouteContext["database"], key: string) {
  const normalized = parseIssueKey(key);
  const issue = normalized
    ? (await database.db.select().from(issues).where(eq(issues.key, normalized)).limit(1))[0]
    : undefined;
  if (!issue) throw new ApiError(404, "issue_not_found");
  return issue;
}

export function assertIssueIdle(engine: AgentController, issueId: string): void {
  if (engine.isRunning(issueId)) throw new ApiError(409, "issue_already_running");
}

export function assertIssueRunnable(issue: Pick<typeof issues.$inferSelect, "status">): void {
  if (issue.status === "resolved") throw new ApiError(409, "resolved_issue_cannot_run_agent");
}

export async function touchIssue(executor: Pick<Database, "update">, issueId: string): Promise<void> {
  await executor.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issueId));
}
