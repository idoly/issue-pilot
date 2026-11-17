import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { AgentBusyError, type AgentController, type AgentReservation } from "../agent/contracts.ts";
import type { AgentEventBus } from "../agent/events.ts";
import type { DatabaseConnection } from "../db/client.ts";
import { environments, type subjects } from "../db/schema.ts";
import { DomainError } from "../domain/errors.ts";
import type { AgentModelCatalog } from "../agent/model-runtime.ts";
import type { WorkspaceLifecycleManager } from "../workspace/lifecycle.ts";
import type { IssueScopeTransitionManager } from "../workspace/scope-transition.ts";
import type { SourceBrowser } from "../workspace/source-browser.ts";

export { authorizeWorkMode, ensureCurrentSubject, requireAdmin, requireCurrentUser, requireDeveloper, requireDeveloperUser, requireIssue } from "../configuration/access.ts";

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

/** An Issue stores its deployment environment by ID; the kind decides whether its code is writable at all. */
export async function issueEnvironmentKind(database: Pick<DatabaseConnection, "db">, issue: { environmentId: string }) {
  const [environment] = await database.db.select({ kind: environments.kind }).from(environments).where(eq(environments.id, issue.environmentId)).limit(1);
  if (!environment) throw new DomainError("issue_not_found", "not_found");
  return environment.kind;
}

export function serializePerson(person: typeof subjects.$inferSelect) {
  return { subject: person.subject, name: person.displayName ?? person.subject, email: person.email ?? "", role: person.role, ...(person.isAdmin ? { isAdmin: true } : {}) };
}

/** Reserve Issues for a change; a busy Issue is refused with the caller's public conflict code when one is given. */
export async function runIssueExclusive<T>(engine: AgentController, issueIds: string[], operation: (reservation: AgentReservation) => Promise<T>, busyCode?: string): Promise<T> {
  try {
    return await engine.runExclusive(issueIds, operation);
  } catch (error) {
    if (busyCode && error instanceof AgentBusyError) throw new DomainError(busyCode, "conflict", { cause: error });
    throw error;
  }
}
