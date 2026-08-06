CREATE TABLE `issue_agent_results` (
  `issue_id` text PRIMARY KEY NOT NULL,
  `outcome` text NOT NULL,
  `summary` text NOT NULL,
  `root_cause` text,
  `evidence` text DEFAULT '[]' NOT NULL,
  `changes` text DEFAULT '[]' NOT NULL,
  `verification` text DEFAULT '[]' NOT NULL,
  `risks` text DEFAULT '[]' NOT NULL,
  `policy_version` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
