-- Retired secrets are exported offline from a verified checkpoint before this migration runs.
-- The columns below have no runtime reader: personal model groups use model_credentials, parameters
-- use application_settings.parameters, and mysql_stdio is private historical evidence only.
ALTER TABLE `user_credentials` DROP COLUMN `model_api_keys`;
--> statement-breakpoint
ALTER TABLE `application_settings` DROP COLUMN `mysql_stdio`;
--> statement-breakpoint
ALTER TABLE `application_settings` DROP COLUMN `max_concurrent_issues`;
--> statement-breakpoint
-- Remove retired capability and historical MCP binding keys from every valid deployment object.
-- archivedDevelopment stays: the configuration parser still inspects it for development deployments.
UPDATE `service_deployments`
SET `config` = json_remove(`config`, '$.nacos', '$.db', '$.redis', '$.mq', '$.es', '$.mcpServices')
WHERE CASE WHEN json_valid(`config`) THEN
  json_type(`config`) = 'object' AND (
    json_type(`config`, '$.nacos') IS NOT NULL
    OR json_type(`config`, '$.db') IS NOT NULL
    OR json_type(`config`, '$.redis') IS NOT NULL
    OR json_type(`config`, '$.mq') IS NOT NULL
    OR json_type(`config`, '$.es') IS NOT NULL
    OR json_type(`config`, '$.mcpServices') IS NOT NULL
  )
END;
