CREATE TABLE `issue_scope_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`actor_subject` text NOT NULL,
	`action` text NOT NULL,
	`from_service_key` text NOT NULL,
	`from_service_name` text NOT NULL,
	`from_work_mode` text NOT NULL,
	`to_service_key` text NOT NULL,
	`to_service_name` text NOT NULL,
	`to_work_mode` text NOT NULL,
	`plan_hash` text NOT NULL,
	`repositories` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_subject`) REFERENCES `subjects`(`subject`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `issue_scope_transitions_issue_created_idx` ON `issue_scope_transitions` (`issue_id`, `created_at`);
