ALTER TABLE `issue_workspaces` ADD COLUMN `released_at` integer;
--> statement-breakpoint
UPDATE `issue_workspaces`
SET `released_at` = `updated_at`
WHERE `status` = 'stopped'
  AND EXISTS (SELECT 1 FROM `issue_repositories` AS `repository` WHERE `repository`.`issue_id` = `issue_workspaces`.`issue_id`)
  AND NOT EXISTS (
    SELECT 1 FROM `issue_repositories` AS `repository`
    WHERE `repository`.`issue_id` = `issue_workspaces`.`issue_id`
      AND (`repository`.`local_path` IS NOT NULL OR `repository`.`working_branch` IS NULL)
  );
