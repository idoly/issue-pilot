import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AgentController } from "../agent/contracts.ts";
import type { DatabaseConnection, DatabaseReader } from "../db/client.ts";
import { dingtalkIssueImports, environments, issues, serviceDeployments, services } from "../db/schema.ts";
import { credentialOwnerSubject, issueScopeForWorkMode, ISSUE_WORK_MODES, requiresDeveloperOwner, type IssueWorkMode } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { choice, text } from "../domain/input.ts";
import { IssueCreatedError } from "./creation-receipt.ts";
import { createIssueRecord, type DingtalkImportClaim } from "./create.ts";
import { parseIssueMetadataInput, parseRelatedIssueKeys, requireDevelopmentOwner, validateRelatedIssues } from "./form-input.ts";
import { removePendingAttachments, type PendingAttachment } from "../workspace/attachments.ts";

export async function resolveCreationScope(db: DatabaseReader, workMode: IssueWorkMode, serviceKey: string) {
  const scope = issueScopeForWorkMode(workMode);
  const [environment] = await db.select().from(environments).where(eq(environments.kind, scope.environmentKind)).limit(1);
  if (!environment) throw new DomainError("invalid_work_mode", "bad_request");
  const [service] = await db
    .select({ id: services.id })
    .from(services)
    .innerJoin(serviceDeployments, and(eq(serviceDeployments.serviceId, services.id), eq(serviceDeployments.environmentId, environment.id)))
    .where(eq(services.key, serviceKey))
    .limit(1);
  if (!service) throw new DomainError("invalid_service_for_work_mode", "bad_request");
  return { type: scope.issueType, environment, serviceId: service.id };
}

export async function createIssue(
  context: { database: DatabaseConnection; engine: AgentController; stateRoot: string; runScopeExclusive<T>(operation: () => Promise<T>): Promise<T> },
  input: Record<string, unknown>,
  options: {
    authorize: (mode: IssueWorkMode) => Promise<string>;
    attachments: PendingAttachment[];
    onCleanupError: (error: unknown) => void;
    dingtalk?: DingtalkImportClaim;
    startAgent?: boolean;
    signal?: AbortSignal;
    now?: () => Date;
  },
) {
  const db = context.database.db;
  const failures: unknown[] = [];
  try {
    const mode = choice(input.workMode, "work_mode", ISSUE_WORK_MODES);
    const reporterSubject = await options.authorize(mode);
    return await context.runScopeExclusive(async () => {
      await options.authorize(mode);
      options.signal?.throwIfAborted();
      const source = options.dingtalk;
      if (source) {
        const [existing] = await db
          .select({ issue: issues })
          .from(dingtalkIssueImports)
          .innerJoin(issues, eq(issues.id, dingtalkIssueImports.issueId))
          .where(and(eq(dingtalkIssueImports.baseId, source.baseId), eq(dingtalkIssueImports.tableId, source.tableId), eq(dingtalkIssueImports.recordId, source.recordId)))
          .limit(1);
        if (existing) return { created: false, issue: existing.issue };
      }
      if (Object.hasOwn(input, "environmentKey") || Object.hasOwn(input, "type")) throw new DomainError("issue_create_scope_contract_invalid", "bad_request");
      const metadata = await parseIssueMetadataInput(db, input);
      const { environment, type, serviceId } = await resolveCreationScope(db, mode, text(input.serviceKey, "service_key", 100));
      if (requiresDeveloperOwner(environment.kind)) await requireDevelopmentOwner(db, credentialOwnerSubject({ assigneeSubject: metadata.assigneeSubject, reporterSubject }));
      const relatedIssueIds = (await validateRelatedIssues(db, parseRelatedIssueKeys(input))).map(({ id }) => id);
      const issueId = randomUUID();
      return context.engine.runExclusive([issueId, ...relatedIssueIds], async (reservation) => {
        options.signal?.throwIfAborted();
        const issue = await createIssueRecord({
          database: db,
          stateRoot: context.stateRoot,
          issueId,
          reporterSubject,
          relatedIssueIds,
          attachments: options.attachments,
          values: { ...metadata, environmentId: environment.id, type, serviceId },
          now: options.now?.() ?? new Date(),
          ...(source ? { dingtalk: source } : {}),
        });
        // Once the record returns, neither scheduling nor assembling a response can undo creation.
        try {
          if (options.startAgent !== false) reservation.enqueue(issue.id);
        } catch (cause) {
          throw new IssueCreatedError("issue_created_enqueue_unconfirmed", issue.key, { cause });
        }
        return { created: true, issue };
      });
    });
  } catch (error) {
    failures.push(error);
    throw error;
  } finally {
    if (failures.length) await removePendingAttachments(options.attachments, failures);
    else await removePendingAttachments(options.attachments).catch(options.onCleanupError);
  }
}
