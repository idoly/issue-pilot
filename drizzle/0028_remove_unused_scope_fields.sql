DROP INDEX `environments_org_scope_idx`;
--> statement-breakpoint
DROP INDEX `environments_owner_key_unique`;
--> statement-breakpoint
DROP INDEX `environments_global_key_unique`;
--> statement-breakpoint
ALTER TABLE `environments` DROP COLUMN `organization_id`;
--> statement-breakpoint
ALTER TABLE `environments` DROP COLUMN `scope`;
--> statement-breakpoint
ALTER TABLE `environments` DROP COLUMN `config`;
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_key_unique` ON `environments` (`key`);
--> statement-breakpoint
DROP INDEX `services_org_scope_idx`;
--> statement-breakpoint
DROP INDEX `services_owner_key_unique`;
--> statement-breakpoint
DROP INDEX `services_global_key_unique`;
--> statement-breakpoint
ALTER TABLE `services` DROP COLUMN `organization_id`;
--> statement-breakpoint
ALTER TABLE `services` DROP COLUMN `scope`;
--> statement-breakpoint
CREATE UNIQUE INDEX `services_key_unique` ON `services` (`key`);
--> statement-breakpoint
ALTER TABLE `issue_workspaces` ADD `code_server_ready` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `issue_workspaces` SET `code_server_ready` = CASE WHEN `code_server_url` IS NULL THEN 0 ELSE 1 END;
--> statement-breakpoint
ALTER TABLE `issue_workspaces` DROP COLUMN `code_server_url`;
