CREATE TABLE `service_repositories_next` (
  `id` text PRIMARY KEY NOT NULL,
  `service_id` text NOT NULL,
  `url` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `service_repositories_next` (`id`, `service_id`, `url`, `created_at`, `updated_at`)
SELECT `id`, `service_id`, `url`, `created_at`, `updated_at` FROM `service_repositories`;
--> statement-breakpoint
DROP TABLE `service_repositories`;
--> statement-breakpoint
ALTER TABLE `service_repositories_next` RENAME TO `service_repositories`;
--> statement-breakpoint
CREATE UNIQUE INDEX `service_repository_url_unique`
  ON `service_repositories` (`service_id`, `url`);
