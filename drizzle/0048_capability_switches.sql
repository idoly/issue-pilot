CREATE TABLE `capability_switches` (
  `key` text PRIMARY KEY NOT NULL CHECK (`key` IN ('nacos','db','redis','mq','es','dms','sls')),
  `enabled` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `capability_switches` (`key`, `enabled`, `updated_at`) VALUES
('nacos',1,unixepoch()), ('db',1,unixepoch()), ('redis',1,unixepoch()),
('mq',1,unixepoch()), ('es',1,unixepoch()), ('dms',1,unixepoch()), ('sls',1,unixepoch());
