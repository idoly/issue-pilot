ALTER TABLE subjects ADD COLUMN revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE user_credentials ADD COLUMN revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE repositories ADD COLUMN revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE services ADD COLUMN revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE user_preferences (
  subject text PRIMARY KEY NOT NULL REFERENCES subjects(subject) ON DELETE CASCADE,
  dingtalk text NOT NULL DEFAULT '{}'
);
--> statement-breakpoint
CREATE TABLE application_settings (
  id integer PRIMARY KEY NOT NULL CHECK (id = 1),
  max_concurrent_issues integer,
  dingtalk_fields text NOT NULL DEFAULT '{}',
  mysql_stdio text
);
--> statement-breakpoint
ALTER TABLE mcp_services ADD COLUMN deployment_id text REFERENCES service_deployments(id) ON DELETE CASCADE;
