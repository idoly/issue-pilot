CREATE TABLE `service_repository_aliases` (
  `id` text PRIMARY KEY NOT NULL,
  `alias` text NOT NULL
);
--> statement-breakpoint
WITH RECURSIVE `repository_names` (`id`, `value`) AS (
  SELECT `id`, rtrim(replace(replace(`url`, '?', '/'), '#', '/'), '/') FROM `service_repositories`
  UNION ALL
  SELECT `id`, substr(`value`, instr(`value`, '/') + 1)
  FROM `repository_names`
  WHERE instr(`value`, '/') > 0
)
INSERT INTO `service_repository_aliases` (`id`, `alias`)
SELECT `id`,
  CASE
    WHEN trim(replace(CASE WHEN instr(`value`, ':') > 0 THEN substr(`value`, instr(`value`, ':') + 1) ELSE `value` END, '.git', '')) = ''
      THEN 'repository-' || substr(replace(`id`, '-', ''), 1, 8)
    ELSE lower(trim(replace(CASE WHEN instr(`value`, ':') > 0 THEN substr(`value`, instr(`value`, ':') + 1) ELSE `value` END, '.git', '')))
  END
FROM `repository_names`
WHERE instr(`value`, '/') = 0;
--> statement-breakpoint
UPDATE `service_repository_aliases`
SET `alias` = `alias` || '-' || substr(replace(`id`, '-', ''), 1, 8)
WHERE EXISTS (
  SELECT 1
  FROM `service_repository_aliases` duplicate
  JOIN `service_repositories` duplicate_repository ON duplicate_repository.`id` = duplicate.`id`
  JOIN `service_repositories` repository ON repository.`id` = `service_repository_aliases`.`id`
  WHERE duplicate_repository.`service_id` = repository.`service_id`
    AND duplicate.`alias` = `service_repository_aliases`.`alias`
    AND duplicate.`id` <> `service_repository_aliases`.`id`
);
--> statement-breakpoint
CREATE TABLE `service_repositories_next` (
  `id` text PRIMARY KEY NOT NULL,
  `service_id` text NOT NULL,
  `alias` text NOT NULL,
  `url` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `service_repositories_next` (`id`, `service_id`, `alias`, `url`, `created_at`, `updated_at`)
SELECT repository.`id`, repository.`service_id`, alias.`alias`, repository.`url`, repository.`created_at`, repository.`updated_at`
FROM `service_repositories` repository
JOIN `service_repository_aliases` alias ON alias.`id` = repository.`id`;
--> statement-breakpoint
DROP TABLE `service_repository_aliases`;
--> statement-breakpoint
DROP TABLE `service_repositories`;
--> statement-breakpoint
ALTER TABLE `service_repositories_next` RENAME TO `service_repositories`;
--> statement-breakpoint
CREATE UNIQUE INDEX `service_repository_alias_unique`
  ON `service_repositories` (`service_id`, `alias`);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_repository_url_unique`
  ON `service_repositories` (`service_id`, `url`);
--> statement-breakpoint
CREATE TABLE `service_deployment_repositories` (
  `deployment_id` text NOT NULL,
  `repository_id` text NOT NULL,
  `base_branch` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`deployment_id`) REFERENCES `service_deployments`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`repository_id`) REFERENCES `service_repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `service_deployment_repositories` (`deployment_id`, `repository_id`, `base_branch`, `created_at`, `updated_at`)
SELECT deployment.`id`, repository.`id`, deployment.`base_branch`, deployment.`created_at`, deployment.`updated_at`
FROM `service_deployments` deployment
JOIN `service_repositories` repository ON repository.`service_id` = deployment.`service_id`;
--> statement-breakpoint
CREATE UNIQUE INDEX `service_deployment_repository_unique`
  ON `service_deployment_repositories` (`deployment_id`, `repository_id`);
--> statement-breakpoint
CREATE INDEX `service_deployment_repository_repository_idx`
  ON `service_deployment_repositories` (`repository_id`);
--> statement-breakpoint
ALTER TABLE `service_deployments` DROP COLUMN `base_branch`;
