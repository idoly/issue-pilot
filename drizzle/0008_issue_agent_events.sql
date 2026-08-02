CREATE TABLE "issue_agent_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "issue_id" uuid NOT NULL,
  "kind" varchar(50) NOT NULL,
  "message" varchar(500) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_agent_events" ADD CONSTRAINT "issue_agent_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "issue_agent_events_issue_idx" ON "issue_agent_events" USING btree ("issue_id", "created_at");
