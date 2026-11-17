import { and, asc, eq } from "drizzle-orm";

import type { DatabaseReader } from "../db/client.ts";
import { issues, subjects } from "../db/schema.ts";
import { canManageDevelopmentConfiguration, canUseIssueWorkMode, hasAdministratorAccess, parseIssueKey, type IssueWorkMode } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";

/** The requested identity travels in one header; HTTP and the application MCP server pass their request headers. */
export interface IdentityRequest {
  headers: Record<string, string | string[] | undefined>;
}
type IdentityDatabase = { db: DatabaseReader };

// Share implicit selection, including an in-flight lookup; authorization always reloads the user.
// Implicit selection exists only in "selectable" mode: in "gateway" mode the HTTP boundary (api.ts)
// rejects API and MCP requests without a subject header before any route reaches this owner.
const defaultRequestSubjects = new WeakMap<object, Promise<string>>();

export async function requireCurrentUser(database: IdentityDatabase, request?: IdentityRequest) {
  const requested = request?.headers["x-issue-pilot-subject"];
  if (Array.isArray(requested)) throw new DomainError("invalid_current_subject", "bad_request");
  let selected = requested;
  if (!selected && request) {
    let selection = defaultRequestSubjects.get(request);
    if (!selection) {
      selection = database.db
        .select({ subject: subjects.subject })
        .from(subjects)
        .where(eq(subjects.active, true))
        .orderBy(asc(subjects.createdAt), asc(subjects.subject))
        .limit(1)
        .then(([user]) => {
          if (!user) throw new DomainError("invalid_current_subject", "bad_request");
          return user.subject;
        });
      defaultRequestSubjects.set(request, selection);
    }
    selected = await selection;
  }
  const [user] = selected
    ? await database.db
        .select()
        .from(subjects)
        .where(and(eq(subjects.subject, selected), eq(subjects.active, true)))
        .limit(1)
    : await database.db.select().from(subjects).where(eq(subjects.active, true)).orderBy(asc(subjects.createdAt), asc(subjects.subject)).limit(1);
  if (!user) throw new DomainError("invalid_current_subject", "bad_request");
  return user;
}

export async function ensureCurrentSubject(database: IdentityDatabase, request?: IdentityRequest): Promise<string> {
  return (await requireCurrentUser(database, request)).subject;
}

export async function requireDeveloper(database: IdentityDatabase, request?: IdentityRequest): Promise<string> {
  const user = await requireCurrentUser(database, request);
  if (!canManageDevelopmentConfiguration(user)) throw new DomainError("developer_role_required", "forbidden");
  return user.subject;
}

/** Source mutations also need the full reloaded person for commit identity; callers use it where requireDeveloper's subject is not enough. */
export async function requireDeveloperUser(database: IdentityDatabase, request?: IdentityRequest) {
  const user = await requireCurrentUser(database, request);
  if (!canManageDevelopmentConfiguration(user)) throw new DomainError("developer_role_required", "forbidden");
  return user;
}

export async function requireAdmin(database: IdentityDatabase, request?: IdentityRequest): Promise<string> {
  const user = await requireCurrentUser(database, request);
  if (!hasAdministratorAccess(user)) throw new DomainError("admin_role_required", "forbidden");
  return user.subject;
}

export async function authorizeWorkMode(database: IdentityDatabase, request: IdentityRequest, workMode: IssueWorkMode): Promise<string> {
  const user = await requireCurrentUser(database, request);
  if (!canUseIssueWorkMode(user.role, workMode)) throw new DomainError("developer_role_required", "forbidden");
  return user.subject;
}

export async function requireIssue(database: IdentityDatabase, key: string) {
  const normalized = parseIssueKey(key);
  const issue = normalized ? (await database.db.select().from(issues).where(eq(issues.key, normalized)).limit(1))[0] : undefined;
  if (!issue) throw new DomainError("issue_not_found", "not_found");
  return issue;
}
