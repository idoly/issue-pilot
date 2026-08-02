CREATE TYPE "public"."diagnosis_classification" AS ENUM('pending', 'bug', 'not_bug', 'change_request', 'cannot_determine');--> statement-breakpoint
CREATE TYPE "public"."evidence_source" AS ENUM('sls', 'dms', 'code', 'attachment', 'user', 'test');--> statement-breakpoint
CREATE TYPE "public"."issue_priority" AS ENUM('p0', 'p1', 'p2', 'p3');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('open', 'in_progress', 'pending', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."issue_type" AS ENUM('incident', 'request', 'problem', 'question', 'task');--> statement-breakpoint
CREATE TYPE "public"."test_scope" AS ENUM('backend', 'frontend', 'integration');--> statement-breakpoint
CREATE TYPE "public"."test_status" AS ENUM('passed', 'failed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."workspace_status" AS ENUM('not_created', 'preparing', 'ready', 'stopped', 'failed');--> statement-breakpoint
CREATE TABLE "issue_agent_sessions" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"pi_session_id" uuid NOT NULL,
	"session_file" text NOT NULL,
	"workspace_path" text NOT NULL,
	"lease_owner" varchar(255),
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"file_name" varchar(500) NOT NULL,
	"media_type" varchar(255) NOT NULL,
	"size" bigint NOT NULL,
	"object_key" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"scan_status" varchar(32) DEFAULT 'pending' NOT NULL,
	"uploaded_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"author_subject" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_diagnoses" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"classification" "diagnosis_classification" DEFAULT 'pending' NOT NULL,
	"root_cause" text,
	"confidence_permille" integer,
	"evidence_ids" uuid[] DEFAULT '{}' NOT NULL,
	"updated_by" varchar(255),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"source" "evidence_source" NOT NULL,
	"summary" text NOT NULL,
	"locator" text,
	"payload" jsonb,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"actor_subject" varchar(255) NOT NULL,
	"action" varchar(100) NOT NULL,
	"changes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"url" text NOT NULL,
	"base_branch" varchar(255) NOT NULL,
	"working_branch" varchar(255),
	"local_path" text,
	"commit_before" varchar(64),
	"commit_after" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"repository_id" uuid,
	"scope" "test_scope" NOT NULL,
	"command" text NOT NULL,
	"status" "test_status" NOT NULL,
	"summary" text NOT NULL,
	"artifact_key" text,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_workspaces" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"status" "workspace_status" DEFAULT 'not_created' NOT NULL,
	"code_server_url" text,
	"owner_subject" varchar(255),
	"branch_created" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(32) NOT NULL,
	"title" varchar(300) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "issue_status" DEFAULT 'open' NOT NULL,
	"priority" "issue_priority" DEFAULT 'p2' NOT NULL,
	"type" "issue_type" DEFAULT 'request' NOT NULL,
	"reporter_subject" varchar(255) NOT NULL,
	"assignee_subject" varchar(255),
	"labels" text[] DEFAULT '{}' NOT NULL,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"subject" varchar(255) PRIMARY KEY NOT NULL,
	"username" varchar(255),
	"display_name" varchar(255),
	"email" varchar(320),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_agent_sessions" ADD CONSTRAINT "issue_agent_sessions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_uploaded_by_subjects_subject_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."subjects"("subject") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_diagnoses" ADD CONSTRAINT "issue_diagnoses_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_evidence" ADD CONSTRAINT "issue_evidence_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_history" ADD CONSTRAINT "issue_history_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_repositories" ADD CONSTRAINT "issue_repositories_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_test_runs" ADD CONSTRAINT "issue_test_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_test_runs" ADD CONSTRAINT "issue_test_runs_repository_id_issue_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."issue_repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_workspaces" ADD CONSTRAINT "issue_workspaces_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_workspaces" ADD CONSTRAINT "issue_workspaces_owner_subject_subjects_subject_fk" FOREIGN KEY ("owner_subject") REFERENCES "public"."subjects"("subject") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_reporter_subject_subjects_subject_fk" FOREIGN KEY ("reporter_subject") REFERENCES "public"."subjects"("subject") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_subject_subjects_subject_fk" FOREIGN KEY ("assignee_subject") REFERENCES "public"."subjects"("subject") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_agent_pi_session_unique" ON "issue_agent_sessions" USING btree ("pi_session_id");--> statement-breakpoint
CREATE INDEX "issue_attachments_issue_idx" ON "issue_attachments" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_comments_issue_idx" ON "issue_comments" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_evidence_issue_idx" ON "issue_evidence" USING btree ("issue_id","source");--> statement-breakpoint
CREATE INDEX "issue_history_issue_idx" ON "issue_history" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_repositories_issue_idx" ON "issue_repositories" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_repository_url_unique" ON "issue_repositories" USING btree ("issue_id","url");--> statement-breakpoint
CREATE INDEX "issue_test_runs_issue_idx" ON "issue_test_runs" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_key_unique" ON "issues" USING btree ("key");--> statement-breakpoint
CREATE INDEX "issues_queue_idx" ON "issues" USING btree ("status","priority","updated_at");--> statement-breakpoint
CREATE INDEX "issues_assignee_idx" ON "issues" USING btree ("assignee_subject","status");