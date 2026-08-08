import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { AgentController } from "../agent/engine.ts";
import type { AgentEventBus } from "../agent/events.ts";
import type { openDatabase } from "../db/client.ts";
import { issues, subjects } from "../db/schema.ts";
import { isIssueKey, normalizeIssueKey } from "../domain/contracts.ts";
import type { AgentModelCatalog } from "../pi/models.ts";
import { ApiError } from "./input.ts";

export interface ApiRouteContext {
  app: FastifyInstance;
  database: ReturnType<typeof openDatabase>;
  engine: AgentController;
  stateRoot: string;
  modelCatalog: AgentModelCatalog;
  events: AgentEventBus;
}

export async function ensureCurrentSubject(database: ApiRouteContext["database"]): Promise<string> {
  const value = process.env.ISSUE_PILOT_SUBJECT ?? "zjj3753@xianhengguoji.com";
  await database.db.insert(subjects).values({ subject: value, username: value, displayName: value, email: "" }).onConflictDoNothing();
  return value;
}

export async function requireIssue(database: ApiRouteContext["database"], key: string) {
  const issue = isIssueKey(key)
    ? (await database.db.select().from(issues).where(eq(issues.key, normalizeIssueKey(key))).limit(1))[0]
    : undefined;
  if (!issue) throw new ApiError(404, "issue_not_found");
  return issue;
}

export function assertIssueIdle(engine: AgentController, issueId: string): void {
  if (engine.isRunning(issueId)) throw new ApiError(409, "issue_already_running");
}
