-- Retired adapter settings remain private deployment history, but cannot be enabled.
CREATE TABLE `capability_switches_new` (
  `key` text PRIMARY KEY NOT NULL CHECK (`key` IN ('dms', 'sls')),
  `enabled` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `capability_switches_new` (`key`, `enabled`, `updated_at`)
SELECT `key`, `enabled`, `updated_at` FROM `capability_switches` WHERE `key` IN ('dms', 'sls');
--> statement-breakpoint
DROP TABLE `capability_switches`;
--> statement-breakpoint
ALTER TABLE `capability_switches_new` RENAME TO `capability_switches`;
--> statement-breakpoint
UPDATE `mcp_services` SET `enabled` = 0, `updated_at` = unixepoch()
WHERE `enabled` <> 0 AND (
  lower(`name`) LIKE '%playwright%'
  OR EXISTS (SELECT 1 FROM json_each(`mcp_services`.`stdio`, '$.args') WHERE CAST(value AS text) LIKE '%@playwright/mcp%')
);
