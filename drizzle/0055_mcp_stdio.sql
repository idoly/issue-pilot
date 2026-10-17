CREATE TABLE `mcp_services_stdio` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `url` text NOT NULL,
  `transport` text NOT NULL CHECK (`transport` IN ('streamable_http','sse','stdio')),
  `stdio` text,
  `authorization` text NOT NULL DEFAULT '',
  `enabled` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `mcp_services_stdio` (`id`,`name`,`url`,`transport`,`authorization`,`enabled`,`created_at`,`updated_at`)
SELECT `id`,`name`,`url`,`transport`,`authorization`,`enabled`,`created_at`,`updated_at` FROM `mcp_services`;
--> statement-breakpoint
DROP TABLE `mcp_services`;
--> statement-breakpoint
ALTER TABLE `mcp_services_stdio` RENAME TO `mcp_services`;
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_service_name_unique` ON `mcp_services` (`name`);
