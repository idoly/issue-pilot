CREATE TABLE `repositories` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `url` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_url_unique` ON `repositories` (`url`);
--> statement-breakpoint
INSERT INTO `repositories` (`id`, `name`, `url`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), `url`, `url`, min(`created_at`), max(`updated_at`)
FROM `service_repositories` GROUP BY `url`;
--> statement-breakpoint
CREATE TABLE `_repository_branches_backup` AS SELECT rowid AS original_rowid, * FROM `service_deployment_repositories`;
--> statement-breakpoint
DROP TABLE `service_deployment_repositories`;
--> statement-breakpoint
CREATE TABLE `_service_repositories_new` (
  `id` text PRIMARY KEY NOT NULL,
  `service_id` text NOT NULL REFERENCES `services` (`id`) ON DELETE CASCADE,
  `alias` text NOT NULL,
  `url` text NOT NULL REFERENCES `repositories` (`url`) ON DELETE RESTRICT ON UPDATE CASCADE,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `_service_repositories_new` (rowid, `id`, `service_id`, `alias`, `url`, `created_at`, `updated_at`)
SELECT rowid, `id`, `service_id`, `alias`, `url`, `created_at`, `updated_at` FROM `service_repositories`;
--> statement-breakpoint
DROP TABLE `service_repositories`;
--> statement-breakpoint
ALTER TABLE `_service_repositories_new` RENAME TO `service_repositories`;
--> statement-breakpoint
CREATE UNIQUE INDEX `service_repository_alias_unique` ON `service_repositories` (`service_id`, `alias`);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_repository_url_unique` ON `service_repositories` (`service_id`, `url`);
--> statement-breakpoint
CREATE TABLE `service_deployment_repositories` (
  `deployment_id` text NOT NULL REFERENCES `service_deployments` (`id`) ON DELETE CASCADE,
  `repository_id` text NOT NULL REFERENCES `service_repositories` (`id`) ON DELETE CASCADE,
  `base_branch` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `service_deployment_repositories` (rowid, `deployment_id`, `repository_id`, `base_branch`, `created_at`, `updated_at`)
SELECT original_rowid, `deployment_id`, `repository_id`, `base_branch`, `created_at`, `updated_at` FROM `_repository_branches_backup`;
--> statement-breakpoint
DROP TABLE `_repository_branches_backup`;
--> statement-breakpoint
CREATE UNIQUE INDEX `service_deployment_repository_unique` ON `service_deployment_repositories` (`deployment_id`, `repository_id`);
--> statement-breakpoint
CREATE INDEX `service_deployment_repository_repository_idx` ON `service_deployment_repositories` (`repository_id`);
