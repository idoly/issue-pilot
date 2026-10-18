ALTER TABLE `subjects` ADD `is_admin` integer NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE `subjects` SET `is_admin` = true, `updated_at` = unixepoch() WHERE `subject` = 'yx4821@xianhengguoji.com';
