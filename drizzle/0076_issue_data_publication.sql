CREATE TABLE `issue_key_sequences` (
  `day` text PRIMARY KEY NOT NULL,
  `last_value` integer NOT NULL CONSTRAINT `issue_key_sequence_range` CHECK (`last_value` BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
INSERT INTO `issue_key_sequences` (`day`, `last_value`)
SELECT substr(`key`, 7, 8), max(CAST(substr(`key`, 16) AS integer))
FROM `issues`
WHERE `key` GLOB 'ISSUE-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9]*'
  AND substr(`key`, 16) NOT GLOB '*[^0-9]*'
GROUP BY substr(`key`, 7, 8)
HAVING max(CAST(substr(`key`, 16) AS integer)) > 0;
--> statement-breakpoint
CREATE TABLE `retired_issue_attachments` (
  `id` text PRIMARY KEY NOT NULL,
  `issue_id` text NOT NULL REFERENCES `issues`(`id`) ON DELETE CASCADE,
  `object_key` text NOT NULL,
  `size` integer NOT NULL,
  `sha256` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `retired_issue_attachments_issue_idx` ON `retired_issue_attachments` (`issue_id`);
