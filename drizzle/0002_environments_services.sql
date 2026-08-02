CREATE TYPE "public"."config_scope" AS ENUM('global', 'personal');--> statement-breakpoint
CREATE TYPE "public"."environment_kind" AS ENUM('production', 'test', 'local');--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar(255) NOT NULL,
	"owner_subject" varchar(255),
	"scope" "config_scope" NOT NULL,
	"key" varchar(100) NOT NULL,
	"name" varchar(200) NOT NULL,
	"kind" "environment_kind" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_environments" (
	"service_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"log_provider" varchar(50),
	"database_provider" varchar(50),
	"connector_source_keys" text[] DEFAULT '{}' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"url" text NOT NULL,
	"default_branch" varchar(255) NOT NULL,
	"role" varchar(100) DEFAULT 'application' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" varchar(255) NOT NULL,
	"owner_subject" varchar(255),
	"scope" "config_scope" NOT NULL,
	"key" varchar(100) NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "service_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_owner_subject_subjects_subject_fk" FOREIGN KEY ("owner_subject") REFERENCES "public"."subjects"("subject") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_environments" ADD CONSTRAINT "service_environments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_environments" ADD CONSTRAINT "service_environments_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_repositories" ADD CONSTRAINT "service_repositories_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_owner_subject_subjects_subject_fk" FOREIGN KEY ("owner_subject") REFERENCES "public"."subjects"("subject") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environments_org_scope_idx" ON "environments" USING btree ("organization_id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_owner_key_unique" ON "environments" USING btree ("organization_id","scope","owner_subject","key");--> statement-breakpoint
CREATE UNIQUE INDEX "service_environment_unique" ON "service_environments" USING btree ("service_id","environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_repository_unique" ON "service_repositories" USING btree ("service_id","url");--> statement-breakpoint
CREATE INDEX "services_org_scope_idx" ON "services" USING btree ("organization_id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "services_owner_key_unique" ON "services" USING btree ("organization_id","scope","owner_subject","key");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;