CREATE TABLE `issue_relations` (
  `issue_id` text NOT NULL REFERENCES `issues`(`id`) ON DELETE CASCADE,
  `related_issue_id` text NOT NULL REFERENCES `issues`(`id`),
  `created_at` integer NOT NULL,
  CONSTRAINT `issue_relations_not_self` CHECK (`issue_id` <> `related_issue_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_relation_unique` ON `issue_relations` (`issue_id`, `related_issue_id`);
--> statement-breakpoint
CREATE INDEX `issue_relations_issue_idx` ON `issue_relations` (`issue_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `issue_relations_related_idx` ON `issue_relations` (`related_issue_id`);
