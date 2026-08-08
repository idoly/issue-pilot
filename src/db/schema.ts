import { randomUUID } from "node:crypto";

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { ENVIRONMENT_KINDS, ISSUE_PRIORITIES, ISSUE_STATUSES, ISSUE_TYPES, REPOSITORY_KINDS, type DeploymentConfig } from "../domain/contracts.ts";

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
  id: id(), key: text("key").notNull(), name: text("name").notNull(), kind: text("kind", { enum: ENVIRONMENT_KINDS }).notNull(), ...timestamps,
}, (table) => [uniqueIndex("environments_key_unique").on(table.key)]);

export const services = sqliteTable("services", {
  id: id(), key: text("key").notNull(), name: text("name").notNull(), description: text("description").notNull().default(""), ...timestamps,
}, (table) => [uniqueIndex("services_key_unique").on(table.key)]);

export const serviceDeployments = sqliteTable("service_deployments", {
  id: id(), serviceId: text("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
  baseBranch: text("base_branch").notNull(), config: json<DeploymentConfig>("config").notNull(), ...timestamps,
}, (table) => [uniqueIndex("service_deployment_unique").on(table.serviceId, table.environmentId)]);

export const serviceRepositories = sqliteTable("service_repositories", {
  id: id(), serviceId: text("service_id").notNull().references(() => services.id, { onDelete: "cascade" }), kind: text("kind", { enum: REPOSITORY_KINDS }).notNull().default("backend"), url: text("url").notNull(), ...timestamps,
}, (table) => [uniqueIndex("service_repository_url_unique").on(table.serviceId, table.url)]);

export const issues = sqliteTable("issues", {
  id: id(), key: text("key").notNull(), title: text("title").notNull(), description: text("description").notNull().default(""),
  status: text("status", { enum: ISSUE_STATUSES }).notNull().default("open"),
  priority: text("priority", { enum: ISSUE_PRIORITIES }).notNull().default("p2"),
  type: text("type", { enum: ISSUE_TYPES }).notNull().default("smart_analysis"),
  serviceId: text("service_id").notNull().references(() => services.id), environmentId: text("environment_id").notNull().references(() => environments.id),
  reporterSubject: text("reporter_subject").notNull().references(() => subjects.subject), assigneeSubject: text("assignee_subject").references(() => subjects.subject),
  resolvedAt: date("resolved_at"), version: integer("version").notNull().default(1), ...timestamps,
}, (table) => [uniqueIndex("issues_key_unique").on(table.key), index("issues_queue_idx").on(table.status, table.priority, table.updatedAt), index("issues_assignee_idx").on(table.assigneeSubject, table.status)]);

export const issueCcRecipients = sqliteTable("issue_cc_recipients", {
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), subject: text("subject").notNull().references(() => subjects.subject), createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [uniqueIndex("issue_cc_recipient_unique").on(table.issueId, table.subject), index("issue_cc_recipient_subject_idx").on(table.subject, table.createdAt)]);

export const issueRepositories = sqliteTable("issue_repositories", {
  id: id(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), url: text("url").notNull(), baseBranch: text("base_branch").notNull(),
  workingBranch: text("working_branch"), localPath: text("local_path"), commitBefore: text("commit_before"), ...timestamps,
}, (table) => [index("issue_repositories_issue_idx").on(table.issueId), uniqueIndex("issue_repository_url_unique").on(table.issueId, table.url)]);

export const issueAttachments = sqliteTable("issue_attachments", {
  id: id(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), fileName: text("file_name").notNull(), mediaType: text("media_type").notNull(), size: integer("size").notNull(),
  objectKey: text("object_key").notNull(), sha256: text("sha256").notNull(), uploadedBy: text("uploaded_by").notNull().references(() => subjects.subject),
  createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [index("issue_attachments_issue_idx").on(table.issueId)]);

export const issueComments = sqliteTable("issue_comments", {
  id: id(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), authorSubject: text("author_subject").notNull(), body: text("body").notNull(), createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [index("issue_comments_issue_idx").on(table.issueId, table.createdAt)]);

export const agentSessions = sqliteTable("issue_pilot_sessions", {
  issueId: text("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }), piSessionId: text("pi_session_id").notNull(), sessionFile: text("session_file").notNull(), workspacePath: text("workspace_path").notNull(), ...timestamps,
}, (table) => [uniqueIndex("issue_pilot_pi_session_unique").on(table.piSessionId)]);

export const issueWorkspaces = sqliteTable("issue_workspaces", {
  issueId: text("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }), status: text("status", { enum: ["not_created", "preparing", "running", "ready", "stopped", "failed"] }).notNull().default("not_created"),
  codeServerReady: integer("code_server_ready", { mode: "boolean" }).notNull().default(false), lastError: text("last_error"), ...timestamps,
});

export const issueHistory = sqliteTable("issue_history", {
  id: id(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), actorSubject: text("actor_subject").notNull(), action: text("action").notNull(),
  changes: json<Record<string, unknown>>("changes").notNull(), createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [index("issue_history_issue_idx").on(table.issueId, table.createdAt)]);
