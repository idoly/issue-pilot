CREATE TABLE IF NOT EXISTS "service_modules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "service_id" uuid NOT NULL,
  "name" varchar(200) NOT NULL,
  "path" varchar(1000) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "service_modules_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_module_name_unique" ON "service_modules" USING btree ("service_id", "name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_module_path_unique" ON "service_modules" USING btree ("service_id", "path");
--> statement-breakpoint
INSERT INTO "service_modules" ("service_id", "name", "path")
SELECT "service_id", regexp_replace("module_path", '^.*/', ''), "module_path"
FROM "service_repositories"
WHERE "module_path" IS NOT NULL AND "module_path" <> ''
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_service_modules" (
  "issue_id" uuid NOT NULL,
  "module_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "issue_service_modules_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "issue_service_modules_module_id_service_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."service_modules"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_service_module_unique" ON "issue_service_modules" USING btree ("issue_id", "module_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_relation_modules" (
  "source_service_id" uuid NOT NULL,
  "target_service_id" uuid NOT NULL,
  "module_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "service_relation_modules_source_service_id_services_id_fk" FOREIGN KEY ("source_service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "service_relation_modules_target_service_id_services_id_fk" FOREIGN KEY ("target_service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "service_relation_modules_module_id_service_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."service_modules"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_relation_module_unique" ON "service_relation_modules" USING btree ("source_service_id", "target_service_id", "module_id");
--> statement-breakpoint
ALTER TABLE "service_repositories" DROP COLUMN IF EXISTS "module_path";
