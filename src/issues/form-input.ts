import { and, eq, inArray } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { DatabaseReader } from "../db/client.ts";
import { issues, subjects } from "../db/schema.ts";
import { ISSUE_PRIORITIES, parseIssueKey } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { choice, optionalText, strings, text } from "../domain/input.ts";

export async function requireDevelopmentOwner(db: DatabaseReader, subject: string) {
  const [owner] = await db.select({ role: subjects.role, active: subjects.active }).from(subjects).where(eq(subjects.subject, subject)).limit(1);
  if (owner?.role !== "developer" || !owner.active) throw new DomainError("issue_developer_owner_required", "bad_request");
}

export async function parseIssueMetadataInput(db: DatabaseReader, input: Record<string, unknown>) {
  const assigneeSubject = optionalText(input.assigneeSubject, 255);
  const ccSubjects = [...new Set(strings(input.ccSubjects ?? [], "cc_subjects"))];
  const requested = [...new Set([...(assigneeSubject ? [assigneeSubject] : []), ...ccSubjects])];
  if (requested.length) {
    const matching = await db
      .select({ subject: subjects.subject })
      .from(subjects)
      .where(and(inArray(subjects.subject, requested), eq(subjects.active, true)));
    if (matching.length !== requested.length) throw new DomainError("invalid_subject", "bad_request");
  }
  return { title: text(input.title, "title", 300), description: optionalText(input.description) ?? "", priority: choice(input.priority, "priority", ISSUE_PRIORITIES), assigneeSubject, ccSubjects };
}

export function parseRelatedIssueKeys(input: Record<string, unknown>) {
  const raw = strings(input.relatedIssueKeys ?? [], "related_issue_keys");
  if (raw.length > issuePilotConfig.limits.relatedIssues) throw new DomainError("related_issue_limit_exceeded", "bad_request");
  const keys = [...new Set(raw.map((key) => parseIssueKey(key.trim())).filter((key): key is string => Boolean(key)))];
  if (keys.length !== raw.length) throw new DomainError("invalid_related_issues", "bad_request");
  return keys;
}

export async function validateRelatedIssues(db: DatabaseReader, keys: string[]) {
  if (!keys.length) return [];
  const rows = await db.select().from(issues).where(inArray(issues.key, keys));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  if (byKey.size !== keys.length) throw new DomainError("invalid_related_issues", "bad_request");
  return keys.map((key) => byKey.get(key)!);
}
