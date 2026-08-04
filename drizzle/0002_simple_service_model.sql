ALTER TABLE `services` ADD `kind` text DEFAULT 'backend' NOT NULL;
--> statement-breakpoint
ALTER TABLE `service_repositories` ADD `project_path` text DEFAULT '.' NOT NULL;
--> statement-breakpoint
ALTER TABLE `service_relations` ADD `note` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `service_relations` SET `relation_type` = 'related' WHERE `relation_type` NOT IN ('calls', 'async', 'related');
