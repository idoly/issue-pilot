import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { type AgentRuntimeConfiguration, AGENT_CODEMODE_MODES, MCP_TRANSPORTS, type McpStdioConfiguration, CAPABILITY_KEYS, USER_ROLES, ENVIRONMENT_KINDS, ISSUE_PRIORITIES, ISSUE_STATUSES, ISSUE_TYPES, ISSUE_WORK_MODES, WORKSPACE_STATUSES, type StoredDeploymentConfig, type IssueWorkMode } from "../domain/contracts.ts";

const id = (name = "id") => text(name).primaryKey().$defaultFn(randomUUID);
const date = (name: string) => integer(name, { mode: "timestamp" });
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
const timestamps = {
  createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
  updatedAt: date("updated_at").notNull().$defaultFn(() => new Date()),
};

export const subjects = sqliteTable("subjects", {
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  role: text("role", { enum: USER_ROLES }).notNull().default("product"),
  subject: text("subject").primaryKey(), displayName: text("display_name"), email: text("email"), active: integer("active", { mode: "boolean" }).notNull().default(true), ...timestamps,
}, (table) => [index("subjects_active_name_idx").on(table.active, table.displayName), check("subjects_role_valid", sql`${table.role} in ('product', 'test', 'developer')`)]);

export const userCredentials = sqliteTable("user_credentials", {
  subject: text("subject").primaryKey().references(() => subjects.subject, { onDelete: "cascade" }),
  modelApiKeys: json<Record<string, string>>("model_api_keys").notNull().default({}),
  productionDmsUrl: text("production_dms_url").notNull().default(""),
  productionDmsAuthorization: text("production_dms_authorization").notNull().default(""),
  productionSlsAccessKeyId: text("production_sls_access_key_id").notNull().default(""),
  productionSlsAccessKeySecret: text("production_sls_access_key_secret").notNull().default(""),
  gitPrivateKey: text("git_private_key").notNull().default(""),
  updatedAt: date("updated_at").notNull().$defaultFn(() => new Date()),
});

export const environments = sqliteTable("environments", {
  id: id(), key: text("key").notNull(), name: text("name").notNull(), kind: text("kind", { enum: ENVIRONMENT_KINDS }).notNull(), ...timestamps,
}, (table) => [uniqueIndex("environments_key_unique").on(table.key)]);

export const services = sqliteTable("services", {
  id: id(), key: text("key").notNull(), name: text("name").notNull(), description: text("description").notNull().default(""), ...timestamps,
}, (table) => [uniqueIndex("services_key_unique").on(table.key)]);

export const mcpServices = sqliteTable("mcp_services", {
  id: id(), name: text("name").notNull(), url: text("url").notNull(),
  transport: text("transport", { enum: MCP_TRANSPORTS }).notNull(),
  stdio: json<McpStdioConfiguration>("stdio"),
  authorization: text("authorization").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false), ...timestamps,
}, (table) => [uniqueIndex("mcp_service_name_unique").on(table.name), check("mcp_transport_valid", sql`${table.transport} IN ('streamable_http','sse','stdio')`)]);

export const capabilitySwitches = sqliteTable("capability_switches", {
  key: text("key", { enum: CAPABILITY_KEYS }).primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  updatedAt: date("updated_at").notNull().$defaultFn(() => new Date()),
}, (table) => [check("capability_switch_key_valid", sql`${table.key} IN ('dms','sls')`)]);

export const globalAgentConfiguration = sqliteTable("global_agent_configuration", {
  id: integer("id").primaryKey(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  thinkingLevel: text("thinking_level").notNull(),
  codemode: text("codemode", { enum: AGENT_CODEMODE_MODES }).notNull().default("on"),
  runtime: json<AgentRuntimeConfiguration>("runtime").notNull().default({}),
  ...timestamps,
}, (table) => [check("global_agent_configuration_singleton", sql`${table.id} = 1`), check("global_agent_codemode_valid", sql`${table.codemode} IN ('off','on','only')`)]);

export const serviceDeployments = sqliteTable("service_deployments", {
  id: id(), serviceId: text("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
  config: json<StoredDeploymentConfig>("config").notNull(), ...timestamps,
}, (table) => [uniqueIndex("service_deployment_unique").on(table.serviceId, table.environmentId)]);

export const repositories = sqliteTable("repositories", {
  id: id(), name: text("name").notNull(), url: text("url").notNull(), ...timestamps,
}, (table) => [uniqueIndex("repositories_url_unique").on(table.url)]);

export const serviceRepositories = sqliteTable("service_repositories", {
  id: id(), serviceId: text("service_id").notNull().references(() => services.id, { onDelete: "cascade" }), alias: text("alias").notNull(), url: text("url").notNull().references(() => repositories.url, { onUpdate: "cascade", onDelete: "restrict" }), ...timestamps,
}, (table) => [uniqueIndex("service_repository_alias_unique").on(table.serviceId, table.alias), uniqueIndex("service_repository_url_unique").on(table.serviceId, table.url)]);

export const serviceDeploymentRepositories = sqliteTable("service_deployment_repositories", {
  deploymentId: text("deployment_id").notNull().references(() => serviceDeployments.id, { onDelete: "cascade" }),
  repositoryId: text("repository_id").notNull().references(() => serviceRepositories.id, { onDelete: "cascade" }),
  baseBranch: text("base_branch").notNull(), ...timestamps,
}, (table) => [uniqueIndex("service_deployment_repository_unique").on(table.deploymentId, table.repositoryId), index("service_deployment_repository_repository_idx").on(table.repositoryId)]);

export const issues = sqliteTable("issues", {
  id: id(), key: text("key").notNull(), title: text("title").notNull(), description: text("description").notNull().default(""),
  status: text("status", { enum: ISSUE_STATUSES }).notNull().default("open"),
  priority: text("priority", { enum: ISSUE_PRIORITIES }).notNull().default("p2"),
  type: text("type", { enum: ISSUE_TYPES }).notNull().default("smart_analysis"),
  serviceId: text("service_id").notNull().references(() => services.id), environmentId: text("environment_id").notNull().references(() => environments.id),
  reporterSubject: text("reporter_subject").notNull().references(() => subjects.subject), assigneeSubject: text("assignee_subject").references(() => subjects.subject),
  resolvedAt: date("resolved_at"), ...timestamps,
}, (table) => [uniqueIndex("issues_key_unique").on(table.key), index("issues_queue_idx").on(table.status, table.priority, table.updatedAt), index("issues_assignee_idx").on(table.assigneeSubject, table.status)]);

export const dingtalkIssueImports = sqliteTable("dingtalk_issue_imports", {
  baseId: text("base_id").notNull(), tableId: text("table_id").notNull(), recordId: text("record_id").notNull(),
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  sourceUrl: text("source_url").notNull(),
  importedBy: text("imported_by").notNull().references(() => subjects.subject),
  createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, table => [primaryKey({ columns: [table.baseId, table.tableId, table.recordId] }), index("dingtalk_issue_imports_issue_idx").on(table.issueId)]);

export const issueServiceScopes = sqliteTable("issue_service_scopes", {
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  serviceId: text("service_id").notNull().references(() => services.id),
  createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [primaryKey({ columns: [table.issueId, table.serviceId] }), index("issue_service_scopes_service_idx").on(table.serviceId)]);

export const issueCcRecipients = sqliteTable("issue_cc_recipients", {
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), subject: text("subject").notNull().references(() => subjects.subject),
}, (table) => [uniqueIndex("issue_cc_recipient_unique").on(table.issueId, table.subject)]);

export const issueRelations = sqliteTable("issue_relations", {
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  relatedIssueId: text("related_issue_id").notNull().references(() => issues.id),
  createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [
  check("issue_relations_not_self", sql`${table.issueId} <> ${table.relatedIssueId}`),
  uniqueIndex("issue_relation_unique").on(table.issueId, table.relatedIssueId),
  index("issue_relations_issue_idx").on(table.issueId, table.createdAt),
  index("issue_relations_related_idx").on(table.relatedIssueId),
]);

export const issuePins = sqliteTable("issue_pins", {
  subject: text("subject").notNull().references(() => subjects.subject, { onDelete: "cascade" }),
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [
  primaryKey({ name: "issue_pins_pk", columns: [table.subject, table.issueId] }),
  index("issue_pins_subject_created_idx").on(table.subject, table.createdAt),
]);

export const issueScopeTransitions = sqliteTable("issue_scope_transitions", {
  id: id(),
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  actorSubject: text("actor_subject").notNull().references(() => subjects.subject),
  action: text("action").notNull(),
  fromServiceKey: text("from_service_key").notNull(),
  fromServiceName: text("from_service_name").notNull(),
  fromWorkMode: text("from_work_mode", { enum: ISSUE_WORK_MODES }).$type<IssueWorkMode>().notNull(),
  toServiceKey: text("to_service_key").notNull(),
  toServiceName: text("to_service_name").notNull(),
  toWorkMode: text("to_work_mode", { enum: ISSUE_WORK_MODES }).$type<IssueWorkMode>().notNull(),
  planHash: text("plan_hash").notNull(),
  repositories: json<{ retained: string[]; added: string[]; removed: string[] }>("repositories").notNull(),
  createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [index("issue_scope_transitions_issue_created_idx").on(table.issueId, table.createdAt)]);

export const issueRepositories = sqliteTable("issue_repositories", {
  id: id(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), url: text("url").notNull(), baseBranch: text("base_branch").notNull(),
  workingBranch: text("working_branch"), localPath: text("local_path"), workspaceName: text("workspace_name"), commitBefore: text("commit_before"), ...timestamps,
}, (table) => [index("issue_repositories_issue_idx").on(table.issueId), uniqueIndex("issue_repository_url_unique").on(table.issueId, table.url), uniqueIndex("issue_repository_workspace_name_unique").on(table.issueId, table.workspaceName)]);

export const issueAttachments = sqliteTable("issue_attachments", {
  id: id(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), fileName: text("file_name").notNull(), mediaType: text("media_type").notNull(), size: integer("size").notNull(),
  objectKey: text("object_key").notNull(), sha256: text("sha256").notNull(), uploadedBy: text("uploaded_by").notNull().references(() => subjects.subject),
  createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [index("issue_attachments_issue_idx").on(table.issueId)]);

export const issueComments = sqliteTable("issue_comments", {
  id: id(), issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }), authorSubject: text("author_subject").notNull(), body: text("body").notNull(), createdAt: date("created_at").notNull().$defaultFn(() => new Date()),
}, (table) => [index("issue_comments_issue_idx").on(table.issueId, table.createdAt)]);

export const agentSessions = sqliteTable("issue_pilot_sessions", {
  issueId: text("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }), sessionFile: text("session_file").notNull(), workspacePath: text("workspace_path").notNull(), ...timestamps,
});

export const issueWorkspaces = sqliteTable("issue_workspaces", {
  issueId: text("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }), status: text("status", { enum: WORKSPACE_STATUSES }).notNull().default("not_created"),
  runtimeReady: integer("runtime_ready", { mode: "boolean" }).notNull().default(false), lastError: text("last_error"), ...timestamps,
});
