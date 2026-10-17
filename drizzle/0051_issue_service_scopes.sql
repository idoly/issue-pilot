CREATE TABLE `issue_service_scopes` (
 `issue_id` text NOT NULL REFERENCES `issues` (`id`) ON DELETE CASCADE,
 `service_id` text NOT NULL REFERENCES `services` (`id`),
 `created_at` integer NOT NULL,
 PRIMARY KEY (`issue_id`,`service_id`)
);
--> statement-breakpoint
CREATE INDEX `issue_service_scopes_service_idx` ON `issue_service_scopes` (`service_id`);
