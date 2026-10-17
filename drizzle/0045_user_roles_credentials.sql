ALTER TABLE `subjects` ADD `role` text NOT NULL DEFAULT 'product' CHECK (`role` IN ('product', 'test', 'developer'));
--> statement-breakpoint
UPDATE `subjects` SET `role` = 'developer';
--> statement-breakpoint
CREATE TABLE `user_credentials` (
  `subject` text PRIMARY KEY NOT NULL REFERENCES `subjects` (`subject`) ON DELETE CASCADE,
  `model_api_keys` text NOT NULL DEFAULT '{}',
  `git_username` text NOT NULL DEFAULT '',
  `git_token` text NOT NULL DEFAULT '',
  `git_private_key` text NOT NULL DEFAULT '',
  `updated_at` integer NOT NULL
);
