CREATE TABLE `mcp_services` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `url` text NOT NULL,
  `transport` text NOT NULL CHECK (`transport` IN ('streamable_http','sse')),
  `authorization` text NOT NULL DEFAULT '',
  `enabled` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_service_name_unique` ON `mcp_services` (`name`);
