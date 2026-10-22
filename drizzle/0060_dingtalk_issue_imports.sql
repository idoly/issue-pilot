CREATE TABLE `dingtalk_issue_imports` (
  `base_id` text NOT NULL,
  `table_id` text NOT NULL,
  `record_id` text NOT NULL,
  `issue_id` text NOT NULL REFERENCES `issues`(`id`) ON DELETE CASCADE,
  `source_url` text NOT NULL,
  `imported_by` text NOT NULL REFERENCES `subjects`(`subject`),
  `created_at` integer NOT NULL,
  PRIMARY KEY (`base_id`, `table_id`, `record_id`)
);
--> statement-breakpoint
CREATE INDEX `dingtalk_issue_imports_issue_idx` ON `dingtalk_issue_imports` (`issue_id`);
