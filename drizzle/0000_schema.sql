CREATE TABLE `issue_pilot_events` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_pilot_events_issue_idx` ON `issue_pilot_events` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `issue_pilot_sessions` (
	`issue_id` text PRIMARY KEY NOT NULL,
	`pi_session_id` text NOT NULL,
	`session_file` text NOT NULL,
	`workspace_path` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_pilot_pi_session_unique` ON `issue_pilot_sessions` (`pi_session_id`);--> statement-breakpoint
CREATE TABLE `deployment_capabilities` (
	`deployment_id` text NOT NULL,
	`capability` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `service_deployments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_capability_unique` ON `deployment_capabilities` (`deployment_id`,`capability`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`owner_subject` text,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_subject`) REFERENCES `subjects`(`subject`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `environments_org_scope_idx` ON `environments` (`organization_id`,`scope`);--> statement-breakpoint
CREATE UNIQUE INDEX `environments_owner_key_unique` ON `environments` (`organization_id`,`scope`,`owner_subject`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `environments_global_key_unique` ON `environments` (`organization_id`,`scope`,`key`) WHERE "environments"."owner_subject" is null;--> statement-breakpoint
CREATE TABLE `issue_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`file_name` text NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	`scan_status` text DEFAULT 'pending' NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `subjects`(`subject`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `issue_attachments_issue_idx` ON `issue_attachments` (`issue_id`);--> statement-breakpoint
CREATE TABLE `issue_cc_recipients` (
	`issue_id` text NOT NULL,
	`subject` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject`) REFERENCES `subjects`(`subject`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_cc_recipient_unique` ON `issue_cc_recipients` (`issue_id`,`subject`);--> statement-breakpoint
CREATE INDEX `issue_cc_recipient_subject_idx` ON `issue_cc_recipients` (`subject`,`created_at`);--> statement-breakpoint
CREATE TABLE `issue_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`author_subject` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_comments_issue_idx` ON `issue_comments` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `issue_diagnoses` (
	`issue_id` text PRIMARY KEY NOT NULL,
	`classification` text DEFAULT 'pending' NOT NULL,
	`root_cause` text,
	`confidence_permille` integer,
	`evidence_ids` text DEFAULT '[]' NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `issue_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`source` text NOT NULL,
	`summary` text NOT NULL,
	`locator` text,
	`payload` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_evidence_issue_idx` ON `issue_evidence` (`issue_id`,`source`);--> statement-breakpoint
CREATE TABLE `issue_history` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`actor_subject` text NOT NULL,
	`action` text NOT NULL,
	`changes` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_history_issue_idx` ON `issue_history` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `issue_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`url` text NOT NULL,
	`base_branch` text NOT NULL,
	`working_branch` text,
	`local_path` text,
	`commit_before` text,
	`commit_after` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_repositories_issue_idx` ON `issue_repositories` (`issue_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_repository_url_unique` ON `issue_repositories` (`issue_id`,`url`);--> statement-breakpoint
CREATE TABLE `issue_service_modules` (
	`issue_id` text NOT NULL,
	`module_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`module_id`) REFERENCES `service_modules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_service_module_unique` ON `issue_service_modules` (`issue_id`,`module_id`);--> statement-breakpoint
CREATE TABLE `issue_services` (
	`issue_id` text NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`deployment_id` text NOT NULL,
	`primary` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deployment_id`) REFERENCES `service_deployments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_service_unique` ON `issue_services` (`issue_id`,`service_id`,`environment_id`);--> statement-breakpoint
CREATE INDEX `issue_services_service_idx` ON `issue_services` (`service_id`,`environment_id`);--> statement-breakpoint
CREATE TABLE `issue_test_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`repository_id` text,
	`scope` text NOT NULL,
	`command` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`artifact_key` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `issue_repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `issue_test_runs_issue_idx` ON `issue_test_runs` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `issue_workspaces` (
	`issue_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'not_created' NOT NULL,
	`code_server_url` text,
	`owner_subject` text,
	`branch_created` integer DEFAULT false NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_subject`) REFERENCES `subjects`(`subject`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text DEFAULT 'p2' NOT NULL,
	`type` text DEFAULT 'request' NOT NULL,
	`service_id` text,
	`environment_id` text,
	`reporter_subject` text NOT NULL,
	`assignee_subject` text,
	`labels` text DEFAULT '[]' NOT NULL,
	`resolved_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reporter_subject`) REFERENCES `subjects`(`subject`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_subject`) REFERENCES `subjects`(`subject`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_key_unique` ON `issues` (`key`);--> statement-breakpoint
CREATE INDEX `issues_queue_idx` ON `issues` (`status`,`priority`,`updated_at`);--> statement-breakpoint
CREATE INDEX `issues_assignee_idx` ON `issues` (`assignee_subject`,`status`);--> statement-breakpoint
CREATE TABLE `service_deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`base_branch` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_deployment_unique` ON `service_deployments` (`service_id`,`environment_id`);--> statement-breakpoint
CREATE TABLE `service_modules` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_module_name_unique` ON `service_modules` (`service_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `service_module_path_unique` ON `service_modules` (`service_id`,`path`);--> statement-breakpoint
CREATE TABLE `service_relation_modules` (
	`source_service_id` text NOT NULL,
	`target_service_id` text NOT NULL,
	`module_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`module_id`) REFERENCES `service_modules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_relation_module_unique` ON `service_relation_modules` (`source_service_id`,`target_service_id`,`module_id`);--> statement-breakpoint
CREATE TABLE `service_relations` (
	`source_service_id` text NOT NULL,
	`target_service_id` text NOT NULL,
	`relation_type` text DEFAULT 'depends_on' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_relation_unique` ON `service_relations` (`source_service_id`,`target_service_id`,`relation_type`);--> statement-breakpoint
CREATE TABLE `service_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`url` text NOT NULL,
	`role` text DEFAULT 'application' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_repository_one_per_service` ON `service_repositories` (`service_id`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`owner_subject` text,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_subject`) REFERENCES `subjects`(`subject`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `services_org_scope_idx` ON `services` (`organization_id`,`scope`);--> statement-breakpoint
CREATE UNIQUE INDEX `services_owner_key_unique` ON `services` (`organization_id`,`scope`,`owner_subject`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `services_global_key_unique` ON `services` (`organization_id`,`scope`,`key`) WHERE "services"."owner_subject" is null;--> statement-breakpoint
CREATE TABLE `subjects` (
	`subject` text PRIMARY KEY NOT NULL,
	`username` text,
	`display_name` text,
	`email` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
