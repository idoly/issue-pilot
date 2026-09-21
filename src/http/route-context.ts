import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AgentController, AgentReservation } from "../agent/engine.ts";
import type { AgentEventBus } from "../agent/events.ts";
import type { DatabaseConnection } from "../db/client.ts";
import { issues, subjects } from "../db/schema.ts";
import { parseIssueKey } from "../domain/contracts.ts";
import type { AgentModelCatalog } from "../pi/models.ts";
import type { WorkspaceLifecycleManager } from "../workspace/lifecycle.ts";
import type { IssueScopeTransitionManager } from "../workspace/scope-transition.ts";
import type { SourceBrowser } from "../workspace/source-browser.ts";
import { ApiError } from "./input.ts";

export interface ApiRouteContext {
  app: FastifyInstance;
  database: DatabaseConnection;
  engine: AgentController;
  stateRoot: string;
  modelCatalog: AgentModelCatalog;
  events: AgentEventBus;
  workspaces: WorkspaceLifecycleManager;
  scopeTransitions: IssueScopeTransitionManager;
  sourceBrowser: SourceBrowser;
  runScopeExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export function serializePerson(person: typeof subjects.$inferSelect) {
  return { subject: person.subject, name: person.displayName ?? person.subject, email: person.email ?? "" };
}

export async function ensureCurrentSubject(database: ApiRouteContext["database"], request?: Pick<FastifyRequest, "headers">): Promise<string> {
  const requested = request?.headers["x-issue-pilot-subject"];
  if (Array.isArray(requested)) throw new ApiError(400, "invalid_current_subject");
  const [user] = requested
    ? await database.db.select({ subject: subjects.subject }).from(subjects).where(and(eq(subjects.subject, requested), eq(subjects.active, true))).limit(1)
    : await database.db.select({ subject: subjects.subject }).from(subjects).where(eq(subjects.active, true)).orderBy(asc(subjects.createdAt), asc(subjects.subject)).limit(1);
  if (!user) throw new ApiError(400, "invalid_current_subject");
  return user.subject;
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
