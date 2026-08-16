ALTER TABLE `subjects` DROP COLUMN `username`;
--> statement-breakpoint
ALTER TABLE `subjects` ADD `active` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `issue_workspaces` RENAME COLUMN `code_server_ready` TO `runtime_ready`;
--> statement-breakpoint
CREATE INDEX `subjects_active_name_idx` ON `subjects` (`active`,`display_name`);
