CREATE TABLE `environments_next` (
  `id` text PRIMARY KEY NOT NULL,
  `key` text NOT NULL,
  `name` text NOT NULL,
  `kind` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `environments_next` (`id`, `key`, `name`, `kind`, `created_at`, `updated_at`)
SELECT `id`, `key`, `name`, `kind`, `created_at`, `updated_at` FROM `environments`;
--> statement-breakpoint
DROP TABLE `environments`;
--> statement-breakpoint
ALTER TABLE `environments_next` RENAME TO `environments`;
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_key_unique` ON `environments` (`key`);
--> statement-breakpoint
CREATE TABLE `services_next` (
  `id` text PRIMARY KEY NOT NULL,
  `key` text NOT NULL,
  `name` text NOT NULL,
  `description` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `services_next` (`id`, `key`, `name`, `description`, `created_at`, `updated_at`)
SELECT `id`, `key`, `name`, `description`, `created_at`, `updated_at` FROM `services`;
--> statement-breakpoint
DROP TABLE `services`;
--> statement-breakpoint
ALTER TABLE `services_next` RENAME TO `services`;
--> statement-breakpoint
CREATE UNIQUE INDEX `services_key_unique` ON `services` (`key`);
--> statement-breakpoint
CREATE TABLE `issue_workspaces_next` (
  `issue_id` text PRIMARY KEY NOT NULL,
  `status` text DEFAULT 'not_created' NOT NULL,
  `code_server_ready` integer DEFAULT 0 NOT NULL,
  `last_error` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `issue_workspaces_next` (`issue_id`, `status`, `code_server_ready`, `last_error`, `created_at`, `updated_at`)
SELECT `issue_id`, `status`, `code_server_ready`, `last_error`, `created_at`, `updated_at` FROM `issue_workspaces`;
--> statement-breakpoint
DROP TABLE `issue_workspaces`;
--> statement-breakpoint
ALTER TABLE `issue_workspaces_next` RENAME TO `issue_workspaces`;
