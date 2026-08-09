DROP TABLE `issue_history`;
--> statement-breakpoint
ALTER TABLE `issues` DROP COLUMN `version`;
--> statement-breakpoint
CREATE TABLE `issue_cc_recipients_next` (
  `issue_id` text NOT NULL,
  `subject` text NOT NULL,
  FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`subject`) REFERENCES `subjects`(`subject`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `issue_cc_recipients_next` (`issue_id`, `subject`)
SELECT `issue_id`, `subject` FROM `issue_cc_recipients`;
--> statement-breakpoint
DROP TABLE `issue_cc_recipients`;
--> statement-breakpoint
ALTER TABLE `issue_cc_recipients_next` RENAME TO `issue_cc_recipients`;
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_cc_recipient_unique`
  ON `issue_cc_recipients` (`issue_id`, `subject`);
