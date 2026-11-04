ALTER TABLE application_settings ADD COLUMN parameters text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE application_settings ADD COLUMN parameters_revision integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Keep the saved concurrency as an override; the retired column stays as recovery evidence.
UPDATE application_settings
SET parameters = json_object('maxConcurrentIssues', max_concurrent_issues), parameters_revision = 1
WHERE max_concurrent_issues IS NOT NULL;
