import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const issueStatus = pgEnum("issue_status", ["open", "in_progress", "pending", "resolved", "closed"]);
export const issuePriority = pgEnum("issue_priority", ["p0", "p1", "p2", "p3"]);
export const issueType = pgEnum("issue_type", ["incident", "request", "problem", "question", "task", "smart_analysis"]);
export const evidenceSource = pgEnum("evidence_source", ["sls", "dms", "mysql", "code", "attachment", "user", "test"]);
export const diagnosisClassification = pgEnum("diagnosis_classification", [
  "pending",
  "bug",
  "not_bug",
  "change_request",
  "cannot_determine",
]);
export const testScope = pgEnum("test_scope", ["backend", "frontend", "integration"]);
export const testStatus = pgEnum("test_status", ["passed", "failed", "blocked"]);
export const workspaceStatus = pgEnum("workspace_status", ["not_created", "preparing", "running", "ready", "stopped", "failed"]);
export const configScope = pgEnum("config_scope", ["global", "personal"]);
export const environmentKind = pgEnum("environment_kind", ["production", "test", "local"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const subjects = pgTable("subjects", {
  subject: varchar("subject", { length: 255 }).primaryKey(),
  username: varchar("username", { length: 255 }),
  displayName: varchar("display_name", { length: 255 }),
  email: varchar("email", { length: 320 }),
  ...timestamps,
});

export const environments = pgTable("environments", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: varchar("organization_id", { length: 255 }).notNull(),
  ownerSubject: varchar("owner_subject", { length: 255 }).references(() => subjects.subject, { onDelete: "cascade" }),
  scope: configScope("scope").notNull(),
  key: varchar("key", { length: 100 }).notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  kind: environmentKind("kind").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (table) => [
  index("environments_org_scope_idx").on(table.organizationId, table.scope),
  uniqueIndex("environments_owner_key_unique").on(table.organizationId, table.scope, table.ownerSubject, table.key),
]);

export const services = pgTable("services", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: varchar("organization_id", { length: 255 }).notNull(),
  ownerSubject: varchar("owner_subject", { length: 255 }).references(() => subjects.subject, { onDelete: "cascade" }),
  scope: configScope("scope").notNull(),
  key: varchar("key", { length: 100 }).notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description").notNull().default(""),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (table) => [
  index("services_org_scope_idx").on(table.organizationId, table.scope),
  uniqueIndex("services_owner_key_unique").on(table.organizationId, table.scope, table.ownerSubject, table.key),
]);

export const serviceEnvironments = pgTable("service_environments", {
  serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  environmentId: uuid("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
  logProvider: varchar("log_provider", { length: 50 }),
  databaseProvider: varchar("database_provider", { length: 50 }),
  connectorSourceKeys: text("connector_source_keys").array().notNull().default([]),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (table) => [
  uniqueIndex("service_environment_unique").on(table.serviceId, table.environmentId),
  uniqueIndex("service_environment_one_per_service").on(table.serviceId),
]);

export const serviceRepositories = pgTable("service_repositories", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  defaultBranch: varchar("default_branch", { length: 255 }).notNull(),
  role: varchar("role", { length: 100 }).notNull().default("application"),
  ...timestamps,
}, (table) => [uniqueIndex("service_repository_unique").on(table.serviceId, table.url)]);

export const serviceModules = pgTable("service_modules", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 200 }).notNull(),
  path: varchar("path", { length: 1000 }).notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("service_module_name_unique").on(table.serviceId, table.name),
  uniqueIndex("service_module_path_unique").on(table.serviceId, table.path),
]);

export const serviceRelations = pgTable("service_relations", {
  sourceServiceId: uuid("source_service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  targetServiceId: uuid("target_service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  relationType: varchar("relation_type", { length: 100 }).notNull().default("depends_on"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (table) => [uniqueIndex("service_relation_unique").on(table.sourceServiceId, table.targetServiceId, table.relationType)]);

export const serviceRelationModules = pgTable("service_relation_modules", {
  sourceServiceId: uuid("source_service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  targetServiceId: uuid("target_service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  moduleId: uuid("module_id").notNull().references(() => serviceModules.id),
  ...timestamps,
}, (table) => [uniqueIndex("service_relation_module_unique").on(table.sourceServiceId, table.targetServiceId, table.moduleId)]);

export const issues = pgTable("issues", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: varchar("key", { length: 32 }).notNull(),
  title: varchar("title", { length: 300 }).notNull(),
  description: text("description").notNull().default(""),
  status: issueStatus("status").notNull().default("open"),
  priority: issuePriority("priority").notNull().default("p2"),
  type: issueType("type").notNull().default("request"),
  serviceId: uuid("service_id").references(() => services.id),
  environmentId: uuid("environment_id").references(() => environments.id),
  reporterSubject: varchar("reporter_subject", { length: 255 }).notNull().references(() => subjects.subject),
  assigneeSubject: varchar("assignee_subject", { length: 255 }).references(() => subjects.subject),
  labels: text("labels").array().notNull().default([]),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  ...timestamps,
}, (table) => [
  uniqueIndex("issues_key_unique").on(table.key),
  index("issues_queue_idx").on(table.status, table.priority, table.updatedAt),
  index("issues_assignee_idx").on(table.assigneeSubject, table.status),
]);

export const issueServices = pgTable("issue_services", {
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id").notNull().references(() => services.id),
  environmentId: uuid("environment_id").references(() => environments.id),
  primary: boolean("primary").notNull().default(false),
  ...timestamps,
}, (table) => [
  uniqueIndex("issue_service_unique").on(table.issueId, table.serviceId, table.environmentId),
  index("issue_services_service_idx").on(table.serviceId, table.environmentId),
]);

export const issueServiceModules = pgTable("issue_service_modules", {
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  moduleId: uuid("module_id").notNull().references(() => serviceModules.id),
  ...timestamps,
}, (table) => [uniqueIndex("issue_service_module_unique").on(table.issueId, table.moduleId)]);

export const issueCcRecipients = pgTable("issue_cc_recipients", {
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  subject: varchar("subject", { length: 255 }).notNull().references(() => subjects.subject),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("issue_cc_recipient_unique").on(table.issueId, table.subject),
  index("issue_cc_recipient_subject_idx").on(table.subject, table.createdAt),
]);

export const issueRepositories = pgTable("issue_repositories", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  baseBranch: varchar("base_branch", { length: 255 }).notNull(),
  workingBranch: varchar("working_branch", { length: 255 }),
  localPath: text("local_path"),
  commitBefore: varchar("commit_before", { length: 64 }),
  commitAfter: varchar("commit_after", { length: 64 }),
  ...timestamps,
}, (table) => [
  index("issue_repositories_issue_idx").on(table.issueId),
  uniqueIndex("issue_repository_url_unique").on(table.issueId, table.url),
]);

export const issueAttachments = pgTable("issue_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  fileName: varchar("file_name", { length: 500 }).notNull(),
  mediaType: varchar("media_type", { length: 255 }).notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  objectKey: text("object_key").notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  scanStatus: varchar("scan_status", { length: 32 }).notNull().default("pending"),
  uploadedBy: varchar("uploaded_by", { length: 255 }).notNull().references(() => subjects.subject),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("issue_attachments_issue_idx").on(table.issueId)]);

export const issueAgentEvents = pgTable("issue_agent_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 50 }).notNull(),
  message: varchar("message", { length: 500 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("issue_agent_events_issue_idx").on(table.issueId, table.createdAt)]);

export const issueComments = pgTable("issue_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  authorSubject: varchar("author_subject", { length: 255 }).notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("issue_comments_issue_idx").on(table.issueId, table.createdAt)]);

export const issueEvidence = pgTable("issue_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  source: evidenceSource("source").notNull(),
  summary: text("summary").notNull(),
  locator: text("locator"),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  createdBy: varchar("created_by", { length: 255 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("issue_evidence_issue_idx").on(table.issueId, table.source)]);

export const issueDiagnoses = pgTable("issue_diagnoses", {
  issueId: uuid("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }),
  classification: diagnosisClassification("classification").notNull().default("pending"),
  rootCause: text("root_cause"),
  confidencePermille: integer("confidence_permille"),
  evidenceIds: uuid("evidence_ids").array().notNull().default([]),
  updatedBy: varchar("updated_by", { length: 255 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const issueTestRuns = pgTable("issue_test_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id").references(() => issueRepositories.id, { onDelete: "set null" }),
  scope: testScope("scope").notNull(),
  command: text("command").notNull(),
  status: testStatus("status").notNull(),
  summary: text("summary").notNull(),
  artifactKey: text("artifact_key"),
  createdBy: varchar("created_by", { length: 255 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("issue_test_runs_issue_idx").on(table.issueId, table.createdAt)]);

export const issueAgentSessions = pgTable("issue_agent_sessions", {
  issueId: uuid("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }),
  piSessionId: uuid("pi_session_id").notNull(),
  sessionFile: text("session_file").notNull(),
  workspacePath: text("workspace_path").notNull(),
  leaseOwner: varchar("lease_owner", { length: 255 }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex("issue_agent_pi_session_unique").on(table.piSessionId)]);

export const issueWorkspaces = pgTable("issue_workspaces", {
  issueId: uuid("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }),
  status: workspaceStatus("status").notNull().default("not_created"),
  codeServerUrl: text("code_server_url"),
  ownerSubject: varchar("owner_subject", { length: 255 }).references(() => subjects.subject),
  branchCreated: boolean("branch_created").notNull().default(false),
  lastError: text("last_error"),
  ...timestamps,
});

export const issueHistory = pgTable("issue_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  actorSubject: varchar("actor_subject", { length: 255 }).notNull(),
  action: varchar("action", { length: 100 }).notNull(),
  changes: jsonb("changes").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("issue_history_issue_idx").on(table.issueId, table.createdAt)]);
