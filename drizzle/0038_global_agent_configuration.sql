CREATE TABLE `global_agent_configuration` (
  `id` integer PRIMARY KEY NOT NULL,
  `provider` text NOT NULL,
  `model` text NOT NULL,
  `thinking_level` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT "global_agent_configuration_singleton" CHECK("global_agent_configuration"."id" = 1)
);
--> statement-breakpoint
INSERT INTO `global_agent_configuration` (`id`, `provider`, `model`, `thinking_level`, `created_at`, `updated_at`)
SELECT 1,
  json_extract(`config`, '$.agent.provider'),
  json_extract(`config`, '$.agent.model'),
  json_extract(`config`, '$.agent.thinkingLevel'),
  unixepoch() * 1000,
  unixepoch() * 1000
FROM `service_deployments`
WHERE json_type(`config`, '$.agent') = 'object'
GROUP BY json_extract(`config`, '$.agent.provider'), json_extract(`config`, '$.agent.model'), json_extract(`config`, '$.agent.thinkingLevel');
--> statement-breakpoint
UPDATE `service_deployments` SET `config` = json_remove(`config`, '$.agent');
