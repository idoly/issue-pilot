import { createHash } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import type { AgentController, AgentReservation } from "../agent/engine.ts";
import type { Database } from "../db/client.ts";
import { environments, issueRelations, issueRepositories, issueScopeTransitions, issues, issueWorkspaces, serviceRepositories, services, subjects } from "../db/schema.ts";
import { issueScopeForWorkMode, issueWorkMode, type IssueWorkMode } from "../domain/contracts.ts";
import { loadDeploymentRepositories } from "./deployment.ts";
import type { WorkspaceLifecycleManager } from "./lifecycle.ts";

export interface ScopeTransitionTarget {
  serviceKey: string;
  workMode: IssueWorkMode;
}

export interface ScopeTransitionExpectation {
  expectedIssueUpdatedAt: string;
  expectedPlanHash: string;
}

interface PlannedRepository {
  name: string;
  url: string;
  baseBranch: string;
}

type ScopeTransitionAction = "none" | "rebind_read_only" | "convert_to_development" | "migrate_development";

export interface ScopeTransitionPlan {
  planHash: string;
  expectedIssueUpdatedAt: string;
  action: ScopeTransitionAction;
  current: {
    service: { key: string; name: string };
    workMode: IssueWorkMode;
    repositoryAccess: "read" | "write";
  };
  target: {
    service: { key: string; name: string };
    workMode: IssueWorkMode;
    repositoryAccess: "read" | "write";
  };
  repositories: {
    retained: PlannedRepository[];
    added: PlannedRepository[];
    removed: PlannedRepository[];
  };
  branch: string | null;
  session: { closeCurrent: boolean; preserveConversation: true };
  preserved: ["attachments", "comments", "conversation"];
  warnings: string[];
}

export class ScopeTransitionRefusal extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

function hashPlan(plan: Omit<ScopeTransitionPlan, "planHash">): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(plan)).digest("hex")}`;
}

function repositoryDiff(current: PlannedRepository[], target: PlannedRepository[], preserveRetainedState: boolean): ScopeTransitionPlan["repositories"] {
  const currentByUrl = new Map(current.map((repository) => [repository.url, repository]));
  const targetByUrl = new Map(target.map((repository) => [repository.url, repository]));
  return {
    retained: preserveRetainedState
      ? current.filter((repository) => targetByUrl.has(repository.url))
      : target.filter((repository) => currentByUrl.has(repository.url)),
    added: target.filter((repository) => !currentByUrl.has(repository.url)),
    removed: current.filter((repository) => !targetByUrl.has(repository.url)),
  };
}

export class IssueScopeTransitionManager {
  private readonly database: Database;
  private readonly engine: AgentController;
  private readonly workspaces: WorkspaceLifecycleManager;

  constructor(database: Database, engine: AgentController, workspaces: WorkspaceLifecycleManager) {
    this.database = database;
    this.engine = engine;
    this.workspaces = workspaces;
  }

  async plan(issueId: string, target: ScopeTransitionTarget): Promise<ScopeTransitionPlan> {
    const [current] = await this.database.select({ issue: issues, environment: environments, service: services, workspace: issueWorkspaces })
      .from(issues)
      .innerJoin(environments, eq(environments.id, issues.environmentId))
      .innerJoin(services, eq(services.id, issues.serviceId))
      .innerJoin(issueWorkspaces, eq(issueWorkspaces.issueId, issues.id))
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!current) throw new ScopeTransitionRefusal("issue_scope_not_found");
    const currentWorkMode = issueWorkMode(current.environment.kind, current.issue.type);
    if (!currentWorkMode) throw new ScopeTransitionRefusal("issue_scope_invalid");

    const targetScope = issueScopeForWorkMode(target.workMode);
    const [targetService, targetEnvironment] = await Promise.all([
      this.database.select().from(services).where(eq(services.key, target.serviceKey)).limit(1).then((rows) => rows[0]),
      this.database.select().from(environments).where(eq(environments.kind, targetScope.environmentKind)).limit(1).then((rows) => rows[0]),
    ]);
    if (!targetService || !targetEnvironment) throw new ScopeTransitionRefusal("scope_transition_target_not_found");

    let targetDeployment;
    try {
      targetDeployment = await loadDeploymentRepositories(this.database, { serviceId: targetService.id, environmentId: targetEnvironment.id });
    } catch (error) {
      if (error instanceof Error && error.message === "issue_service_deployment_not_found") throw new ScopeTransitionRefusal(error.message);
      throw error;
    }

    const [currentRows, currentRepositoryDefinitions, relationRows] = await Promise.all([
      this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, current.issue.id)),
      this.database.select().from(serviceRepositories).where(eq(serviceRepositories.serviceId, current.service.id)),
      this.database.select().from(issueRelations).where(eq(issueRelations.issueId, current.issue.id)),
    ]);
    const currentDefinitionByUrl = new Map(currentRepositoryDefinitions.map((repository) => [repository.url, repository]));
    const currentRepositories = currentRows.map((repository) => ({
      name: currentDefinitionByUrl.get(repository.url)?.alias ?? repository.workspaceName ?? repository.url,
      url: repository.url,
      baseBranch: repository.baseBranch,
    }));
    const targetRepositories = targetDeployment.repositories.map(({ repository, baseBranch }) => ({ name: repository.alias, url: repository.url, baseBranch }));

    const sameScope = current.service.id === targetService.id && currentWorkMode === target.workMode;
    let action: ScopeTransitionAction;
    if (sameScope) action = "none";
    else if (current.environment.kind !== "dev" && targetScope.repositoryAccess === "read") action = "rebind_read_only";
    else if (
      current.environment.kind !== "dev"
      && current.issue.type === "smart_analysis"
      && target.workMode === "development_fix"
      && current.service.id === targetService.id
      && ["open", "pending"].includes(current.issue.status)
      && current.workspace.status === "ready"
    ) action = "convert_to_development";
    else if (current.environment.kind === "dev" && targetScope.repositoryAccess === "write") {
      if (current.issue.type !== targetScope.issueType) throw new ScopeTransitionRefusal("development_branch_mode_immutable");
      if (
        current.service.id !== targetService.id
        && ["open", "pending"].includes(current.issue.status)
        && current.workspace.status === "ready"
      ) action = "migrate_development";
      else throw new ScopeTransitionRefusal("scope_transition_not_supported");
    } else throw new ScopeTransitionRefusal("scope_transition_not_supported");

    const branch = action === "convert_to_development" || action === "migrate_development"
      ? `${targetScope.issueType === "defect_fix" ? "hotfix" : "feature"}-${current.issue.key.toLowerCase()}`
      : null;
    const warnings = relationRows.length && target.workMode !== "production_analysis" ? ["related_issues_will_be_removed"] : [];
    const planWithoutHash: Omit<ScopeTransitionPlan, "planHash"> = {
      expectedIssueUpdatedAt: current.issue.updatedAt.toISOString(),
      action,
      current: {
        service: { key: current.service.key, name: current.service.name },
        workMode: currentWorkMode,
        repositoryAccess: issueScopeForWorkMode(currentWorkMode).repositoryAccess,
      },
      target: {
        service: { key: targetService.key, name: targetService.name },
        workMode: target.workMode,
        repositoryAccess: targetScope.repositoryAccess,
      },
      repositories: repositoryDiff(currentRepositories, targetRepositories, action === "migrate_development"),
      branch,
      session: { closeCurrent: action !== "none", preserveConversation: true },
      preserved: ["attachments", "comments", "conversation"],
      warnings,
    };
    return { planHash: hashPlan(planWithoutHash), ...planWithoutHash };
  }

  async history(issueId: string) {
    const rows = await this.database.select({ transition: issueScopeTransitions, actor: subjects })
      .from(issueScopeTransitions)
      .innerJoin(subjects, eq(subjects.subject, issueScopeTransitions.actorSubject))
      .where(eq(issueScopeTransitions.issueId, issueId))
      .orderBy(desc(issueScopeTransitions.createdAt), desc(issueScopeTransitions.id));
    return rows.map(({ transition, actor }) => ({
      id: transition.id,
      action: transition.action,
      from: { service: { key: transition.fromServiceKey, name: transition.fromServiceName }, workMode: transition.fromWorkMode },
      to: { service: { key: transition.toServiceKey, name: transition.toServiceName }, workMode: transition.toWorkMode },
      repositories: transition.repositories,
      planHash: transition.planHash,
      actor: { subject: actor.subject, name: actor.displayName ?? actor.subject },
      createdAt: transition.createdAt.toISOString(),
    }));
  }

  async apply(issueId: string, target: ScopeTransitionTarget, expectation: ScopeTransitionExpectation, actorSubject: string): Promise<typeof issues.$inferSelect> {
    const initialPlan = await this.plan(issueId, target);
    this.assertExpected(initialPlan, expectation);
    if (initialPlan.action === "none") return this.issue(issueId);
    const recordTransition = this.transitionAudit(issueId, actorSubject, initialPlan);
    if (initialPlan.action === "convert_to_development") {
      try {
        return await this.workspaces.convertIssueToDevelopment(issueId, expectation.expectedIssueUpdatedAt, recordTransition);
      } catch (error) {
        if (error instanceof Error && error.message === "scope_transition_plan_stale") throw new ScopeTransitionRefusal(error.message);
        throw error;
      }
    }
    if (initialPlan.action === "migrate_development") {
      const targetScope = issueScopeForWorkMode(target.workMode);
      const [[targetService], [targetEnvironment]] = await Promise.all([
        this.database.select().from(services).where(eq(services.key, target.serviceKey)).limit(1),
        this.database.select().from(environments).where(eq(environments.kind, targetScope.environmentKind)).limit(1),
      ]);
      if (!targetService || !targetEnvironment) throw new ScopeTransitionRefusal("scope_transition_plan_stale");
      return this.workspaces.migrateDevelopmentIssueScope(
        issueId,
        { serviceId: targetService.id, environmentId: targetEnvironment.id },
        expectation.expectedIssueUpdatedAt,
        recordTransition,
      );
    }
    return this.engine.runExclusive([issueId], async (reservation) => this.applyReadOnlyRebind(issueId, target, expectation, actorSubject, reservation));
  }

  private async applyReadOnlyRebind(issueId: string, target: ScopeTransitionTarget, expectation: ScopeTransitionExpectation, actorSubject: string, reservation: AgentReservation): Promise<typeof issues.$inferSelect> {
    const plan = await this.plan(issueId, target);
    this.assertExpected(plan, expectation);
    if (plan.action !== "rebind_read_only") throw new ScopeTransitionRefusal("scope_transition_plan_stale");
    const targetScope = issueScopeForWorkMode(target.workMode);
    const [[targetService], [targetEnvironment]] = await Promise.all([
      this.database.select().from(services).where(eq(services.key, target.serviceKey)).limit(1),
      this.database.select().from(environments).where(eq(environments.kind, targetScope.environmentKind)).limit(1),
    ]);
    if (!targetService || !targetEnvironment) throw new ScopeTransitionRefusal("scope_transition_plan_stale");
    await reservation.closeSession(issueId);
    const updated = await this.database.transaction(async (transaction) => {
      const now = new Date();
      const [changed] = await transaction.update(issues).set({
        serviceId: targetService.id,
        environmentId: targetEnvironment.id,
        type: targetScope.issueType,
        updatedAt: now,
      }).where(and(eq(issues.id, issueId), eq(issues.updatedAt, new Date(expectation.expectedIssueUpdatedAt)))).returning();
      if (!changed) throw new ScopeTransitionRefusal("scope_transition_plan_stale");
      await transaction.delete(issueRepositories).where(eq(issueRepositories.issueId, issueId));
      if (target.workMode !== "production_analysis") await transaction.delete(issueRelations).where(eq(issueRelations.issueId, issueId));
      await transaction.update(issueWorkspaces).set({ status: "not_created", runtimeReady: false, lastError: null, updatedAt: now }).where(eq(issueWorkspaces.issueId, issueId));
      await this.transitionAudit(issueId, actorSubject, plan)(transaction, now);
      return changed;
    });
    if (updated.status !== "resolved") reservation.enqueue(issueId);
    return updated;
  }

  private transitionAudit(issueId: string, actorSubject: string, plan: ScopeTransitionPlan) {
    return async (writer: Pick<Database, "insert">, createdAt: Date): Promise<void> => {
      await writer.insert(issueScopeTransitions).values({
        issueId,
        actorSubject,
        action: plan.action,
        fromServiceKey: plan.current.service.key,
        fromServiceName: plan.current.service.name,
        fromWorkMode: plan.current.workMode,
        toServiceKey: plan.target.service.key,
        toServiceName: plan.target.service.name,
        toWorkMode: plan.target.workMode,
        planHash: plan.planHash,
        repositories: {
          retained: plan.repositories.retained.map(({ url }) => url),
          added: plan.repositories.added.map(({ url }) => url),
          removed: plan.repositories.removed.map(({ url }) => url),
        },
        createdAt,
      });
    };
  }

  private assertExpected(plan: ScopeTransitionPlan, expectation: ScopeTransitionExpectation): void {
    if (plan.expectedIssueUpdatedAt !== expectation.expectedIssueUpdatedAt || plan.planHash !== expectation.expectedPlanHash) {
      throw new ScopeTransitionRefusal("scope_transition_plan_stale");
    }
  }

  private async issue(issueId: string): Promise<typeof issues.$inferSelect> {
    const [issue] = await this.database.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue) throw new ScopeTransitionRefusal("issue_not_found");
    return issue;
  }
}
