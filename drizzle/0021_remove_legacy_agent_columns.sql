ALTER TABLE `issue_pilot_sessions` DROP COLUMN `lease_owner`;--> statement-breakpoint
ALTER TABLE `issue_pilot_sessions` DROP COLUMN `lease_expires_at`;--> statement-breakpoint
ALTER TABLE `issue_repositories` DROP COLUMN `commit_after`;--> statement-breakpoint
ALTER TABLE `issue_workspaces` DROP COLUMN `branch_created`;
