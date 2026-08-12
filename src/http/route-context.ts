import { eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { issuePilotConfig } from "../../issue-pilot.config.ts";

import type { AgentController, AgentReservation } from "../agent/engine.ts";
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
  runScopeExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export function serializePerson(person: typeof subjects.$inferSelect) {
  return { subject: person.subject, name: person.displayName ?? person.username ?? person.subject, email: person.email ?? "" };
}

async function ensureConfiguredSubject(database: ApiRouteContext["database"], user: typeof issuePilotConfig.users[number]): Promise<void> {
  await database.db.insert(subjects).values({ subject: user.subject, username: user.subject, displayName: user.name, email: user.email }).onConflictDoUpdate({
    target: subjects.subject,
    set: { username: user.subject, displayName: user.name, email: user.email, updatedAt: new Date() },
    setWhere: sql`${subjects.username} IS NOT ${user.subject} OR ${subjects.displayName} IS NOT ${user.name} OR ${subjects.email} IS NOT ${user.email}`,
  });
}

export async function ensureConfiguredSubjects(database: ApiRouteContext["database"]): Promise<void> {
  for (const user of issuePilotConfig.users) await ensureConfiguredSubject(database, user);
}

export async function ensureCurrentSubject(database: ApiRouteContext["database"], request?: Pick<FastifyRequest, "headers">): Promise<string> {
  const requested = request?.headers["x-issue-pilot-subject"];
  if (Array.isArray(requested)) throw new ApiError(400, "invalid_current_subject");
  const subject = requested ?? issuePilotConfig.subject;
  const user = issuePilotConfig.users.find((candidate) => candidate.subject === subject);
  if (!user) throw new ApiError(400, "invalid_current_subject");
  await ensureConfiguredSubject(database, user);
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

export async function runIssueExclusive<T>(engine: AgentController, issueIds: string[], operation: (reservation: AgentReservation) => Promise<T>): Promise<T> {
  try { return await engine.runExclusive(issueIds, operation); }
  catch (error) {
    if (error instanceof Error && error.message === "issue_already_running") throw new ApiError(409, error.message);
    throw error;
  }
}

export function assertIssueRunnable(issue: Pick<typeof issues.$inferSelect, "status">): void {
  if (issue.status === "resolved") throw new ApiError(409, "resolved_issue_cannot_run_agent");
}

export async function touchIssue(executor: Pick<Database, "update">, issueId: string): Promise<void> {
  await executor.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issueId));
}
