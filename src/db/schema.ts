import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = (name = "id") => text(name).primaryKey().$defaultFn(randomUUID);
const date = (name: string) => integer(name, { mode: "timestamp" });
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
const timestamps = {
  createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
  updatedAt: date("updated_at").notNull().$defaultFn(() => new Date()),
};

export const subjects = sqliteTable("subjects", {
  subject: text("subject").primaryKey(), username: text("username"), displayName: text("display_name"), email: text("email"), ...timestamps,
});

export const environments = sqliteTable("environments", {
  id: id(), organizationId: text("organization_id").notNull(), ownerSubject: text("owner_subject").references(() => subjects.subject, { onDelete: "cascade" }),
  scope: text("scope", { enum: ["global", "personal"] }).notNull(), key: text("key").notNull(), name: text("name").notNull(),
  kind: text("kind", { enum: ["production", "test", "local"] }).notNull(), config: json<Record<string, unknown>>("config").notNull().default({}), ...timestamps,
}, (table) => [
  index("environments_org_scope_idx").on(table.organizationId, table.scope),
  uniqueIndex("environments_owner_key_unique").on(table.organizationId, table.scope, table.ownerSubject, table.key),
  uniqueIndex("environments_global_key_unique").on(table.organizationId, table.scope, table.key).where(sql`${table.ownerSubject} is null`),
]);

export const services = sqliteTable("services", {
  id: id(), organizationId: text("organization_id").notNull(), ownerSubject: text("owner_subject").references(() => subjects.subject, { onDelete: "cascade" }),
  scope: text("scope", { enum: ["global", "personal"] }).notNull(), key: text("key").notNull(), name: text("name").notNull(), description: text("description").notNull().default(""), sortOrder: integer("sort_order").notNull().default(0), ...timestamps,
}, (table) => [
  index("services_org_scope_idx").on(table.organizationId, table.scope),
  uniqueIndex("services_owner_key_unique").on(table.organizationId, table.scope, table.ownerSubject, table.key),
  uniqueIndex("services_global_key_unique").on(table.organizationId, table.scope, table.key).where(sql`${table.ownerSubject} is null`),
]);

export const serviceDeployments = sqliteTable("service_deployments", {
  id: id(), serviceId: text("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
  baseBranch: text("base_branch").notNull(), config: json<Record<string, unknown>>("config").notNull().default({}), ...timestamps,
}, (table) => [uniqueIndex("service_deployment_unique").on(table.serviceId, table.environmentId)]);

export const deploymentCapabilities = sqliteTable("deployment_capabilities", {
  deploymentId: text("deployment_id").notNull().references(() => serviceDeployments.id, { onDelete: "cascade" }),
  capability: text("capability", { enum: ["configuration_read", "database_read", "cache_read", "log_read"] }).notNull(), ...timestamps,
}, (table) => [uniqueIndex("deployment_capability_unique").on(table.deploymentId, table.capability)]);

export const serviceRepositories = sqliteTable("service_repositories", {
  id: id(), serviceId: text("service_id").notNull().references(() => services.id, { onDelete: "cascade" }), url: text("url").notNull(), role: text("role").notNull().default("application"), ...timestamps,
}, (table) => [uniqueIndex("service_repository_one_per_service").on(table.serviceId)]);

export const serviceModules = sqliteTable("service_modules", {
  id: id(), serviceId: text("service_id").notNull().references(() => services.id, { onDelete: "cascade" }), name: text("name").notNull(), path: text("path").notNull(), description: text("description").notNull().default(""), ...timestamps,
}, (table) => [uniqueIndex("service_module_name_unique").on(table.serviceId, table.name), uniqueIndex("service_module_path_unique").on(table.serviceId, table.path)]);

export const serviceRelations = sqliteTable("service_relations", {
  sourceServiceId: text("source_service_id").notNull().references(() => services.id, { onDelete: "cascade" }), targetServiceId: text("target_service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  relationType: text("relation_type").notNull().default("depends_on"), metadata: json<Record<string, unknown>>("metadata").notNull().default({}), ...timestamps,
}, (table) => [uniqueIndex("service_relation_unique").on(table.sourceServiceId, table.targetServiceId, table.relationType)]);

export const serviceRelationModules = sqliteTable("service_relation_modules", {
  sourceServiceId: text("source_service_id").notNull().references(() => services.id, { onDelete: "cascade" }), targetServiceId: text("target_service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  moduleId: text("module_id").notNull().references(() => serviceModules.id), ...timestamps,
}, (table) => [uniqueIndex("service_relation_module_unique").on(table.sourceServiceId, table.targetServiceId, table.moduleId)]);

export const issues = sqliteTable("issues", {
  id: id(), key: text("key").notNull(), title: text("title").notNull(), description: text("description").notNull().default(""),
  status: text("status", { enum: ["open", "in_progress", "pending", "resolved", "closed"] }).notNull().default("open"),
  priority: text("priority", { enum: ["p0", "p1", "p2", "p3"] }).notNull().default("p2"),
  type: text("type", { enum: ["incident", "request", "problem", "question", "task", "smart_analysis"] }).notNull().default("request"),
  serviceId: text("service_id").references(() => services.id), environmentId: text("environment_id").references(() => environments.id),
  reporterSubject: text("reporter_subject").notNull().references(() => subjects.subject), assigneeSubject: text("assignee_subject").references(() => subjects.subject),
  labels: json<string[]>("labels").notNull().default([]), resolvedAt: date("resolved_at"), version: integer("version").notNull().default(1), ...timestamps,
}, (table) => [uniqueIndex("issues_key_unique").on(table.key), index("issues_queue_idx").on(table.status, table.priority, table.updatedAt), index("issues_assignee_idx").on(table.assigneeSubject, table.status)]);

export const issueServices = sqliteTable("issue_services", {
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), serviceId: text("service_id").notNull().references(() => services.id),
  environmentId: text("environment_id").notNull().references(() => environments.id), deploymentId: text("deployment_id").notNull().references(() => serviceDeployments.id),
  primary: integer("primary", { mode: "boolean" }).notNull().default(false), ...timestamps,
}, (table) => [uniqueIndex("issue_service_unique").on(table.issueId, table.serviceId, table.environmentId), index("issue_services_service_idx").on(table.serviceId, table.environmentId)]);

export const issueServiceModules = sqliteTable("issue_service_modules", {
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), moduleId: text("module_id").notNull().references(() => serviceModules.id), ...timestamps,
}, (table) => [uniqueIndex("issue_service_module_unique").on(table.issueId, table.moduleId)]);

export const issueCcRecipients = sqliteTable("issue_cc_recipients", {
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), subject: text("subject").notNull().references(() => subjects.subject), createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [uniqueIndex("issue_cc_recipient_unique").on(table.issueId, table.subject), index("issue_cc_recipient_subject_idx").on(table.subject, table.createdAt)]);

export const issueRepositories = sqliteTable("issue_repositories", {
  id: id(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), url: text("url").notNull(), baseBranch: text("base_branch").notNull(),
  workingBranch: text("working_branch"), localPath: text("local_path"), commitBefore: text("commit_before"), commitAfter: text("commit_after"), ...timestamps,
}, (table) => [index("issue_repositories_issue_idx").on(table.issueId), uniqueIndex("issue_repository_url_unique").on(table.issueId, table.url)]);

export const issueAttachments = sqliteTable("issue_attachments", {
  id: id(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), fileName: text("file_name").notNull(), mediaType: text("media_type").notNull(), size: integer("size").notNull(),
  objectKey: text("object_key").notNull(), sha256: text("sha256").notNull(), scanStatus: text("scan_status").notNull().default("pending"), uploadedBy: text("uploaded_by").notNull().references(() => subjects.subject),
  createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [index("issue_attachments_issue_idx").on(table.issueId)]);

export const agentEvents = sqliteTable("issue_pilot_events", {
  id: id(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), kind: text("kind").notNull(), message: text("message").notNull(), createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [index("issue_pilot_events_issue_idx").on(table.issueId, table.createdAt)]);

export const issueComments = sqliteTable("issue_comments", {
  id: id(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), authorSubject: text("author_subject").notNull(), body: text("body").notNull(), createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [index("issue_comments_issue_idx").on(table.issueId, table.createdAt)]);

export const issueEvidence = sqliteTable("issue_evidence", {
  id: id(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), source: text("source", { enum: ["sls", "dms", "mysql", "code", "attachment", "user", "test"] }).notNull(),
  summary: text("summary").notNull(), locator: text("locator"), payload: json<Record<string, unknown>>("payload"), createdBy: text("created_by").notNull(), createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [index("issue_evidence_issue_idx").on(table.issueId, table.source)]);

export const issueDiagnoses = sqliteTable("issue_diagnoses", {
  issueId: text("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }), classification: text("classification", { enum: ["pending", "bug", "not_bug", "change_request", "cannot_determine"] }).notNull().default("pending"),
  rootCause: text("root_cause"), confidencePermille: integer("confidence_permille"), evidenceIds: json<string[]>("evidence_ids").notNull().default([]), updatedBy: text("updated_by"), updatedAt: date("updated_at").notNull().$defaultFn(() => new Date()),
});

export const issueTestRuns = sqliteTable("issue_test_runs", {
  id: id(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), repositoryId: text("repository_id").references(() => issueRepositories.id, { onDelete: "set null" }),
  scope: text("scope", { enum: ["backend", "frontend", "integration"] }).notNull(), command: text("command").notNull(), status: text("status", { enum: ["passed", "failed", "blocked"] }).notNull(),
  summary: text("summary").notNull(), artifactKey: text("artifact_key"), createdBy: text("created_by").notNull(), createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [index("issue_test_runs_issue_idx").on(table.issueId, table.createdAt)]);

export const agentSessions = sqliteTable("issue_pilot_sessions", {
  issueId: text("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }), piSessionId: text("pi_session_id").notNull(), sessionFile: text("session_file").notNull(), workspacePath: text("workspace_path").notNull(),
  leaseOwner: text("lease_owner"), leaseExpiresAt: date("lease_expires_at"), ...timestamps,
}, (table) => [uniqueIndex("issue_pilot_pi_session_unique").on(table.piSessionId)]);

export const issueWorkspaces = sqliteTable("issue_workspaces", {
  issueId: text("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }), status: text("status", { enum: ["not_created", "preparing", "running", "ready", "stopped", "failed"] }).notNull().default("not_created"),
  codeServerUrl: text("code_server_url"), ownerSubject: text("owner_subject").references(() => subjects.subject), branchCreated: integer("branch_created", { mode: "boolean" }).notNull().default(false), lastError: text("last_error"), ...timestamps,
});

export const issueHistory = sqliteTable("issue_history", {
  id: id(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), actorSubject: text("actor_subject").notNull(), action: text("action").notNull(),
  changes: json<Record<string, unknown>>("changes").notNull(), createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [index("issue_history_issue_idx").on(table.issueId, table.createdAt)]);
