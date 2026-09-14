ALTER TABLE `issue_repositories` ADD COLUMN `workspace_name` text;
--> statement-breakpoint
WITH RECURSIVE `workspace_names` (`id`, `value`) AS (
  SELECT `id`, `local_path` FROM `issue_repositories` WHERE `local_path` IS NOT NULL
  UNION ALL
  SELECT `id`, substr(`value`, instr(`value`, '/') + 1)
  FROM `workspace_names`
  WHERE instr(`value`, '/') > 0
)
UPDATE `issue_repositories`
SET `workspace_name` = (
  SELECT `value` FROM `workspace_names`
  WHERE `workspace_names`.`id` = `issue_repositories`.`id` AND instr(`value`, '/') = 0
)
WHERE `local_path` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_repository_workspace_name_unique`
  ON `issue_repositories` (`issue_id`, `workspace_name`);
