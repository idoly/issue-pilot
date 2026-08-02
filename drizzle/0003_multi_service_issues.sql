CREATE TABLE "issue_services" (
	"issue_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"environment_id" uuid,
	"primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_relations" (
	"source_service_id" uuid NOT NULL,
	"target_service_id" uuid NOT NULL,
	"relation_type" varchar(100) DEFAULT 'depends_on' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_services" ADD CONSTRAINT "issue_services_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_services" ADD CONSTRAINT "issue_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_services" ADD CONSTRAINT "issue_services_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_relations" ADD CONSTRAINT "service_relations_source_service_id_services_id_fk" FOREIGN KEY ("source_service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_relations" ADD CONSTRAINT "service_relations_target_service_id_services_id_fk" FOREIGN KEY ("target_service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_service_unique" ON "issue_services" USING btree ("issue_id","service_id","environment_id");--> statement-breakpoint
CREATE INDEX "issue_services_service_idx" ON "issue_services" USING btree ("service_id","environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_relation_unique" ON "service_relations" USING btree ("source_service_id","target_service_id","relation_type");