UPDATE `environments` SET `key` = 'prod', `kind` = 'prod', `updated_at` = unixepoch() * 1000 WHERE `key` = 'production' AND `kind` = 'production';
--> statement-breakpoint
UPDATE `environments` SET `key` = 'dev', `kind` = 'dev', `updated_at` = unixepoch() * 1000 WHERE `key` = 'development' AND `kind` = 'development';
