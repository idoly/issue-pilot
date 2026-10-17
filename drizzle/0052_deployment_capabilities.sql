CREATE TABLE `_deployment_resource_targets` AS
SELECT d.id AS deployment_id, r.id AS resource_id, c.id AS connection_id, c.kind,
 r.name, r.description, r.config AS target_config, r.enabled
FROM resource_services t
JOIN resources r ON r.id=t.resource_id
JOIN resource_connections c ON c.id=r.connection_id
JOIN service_deployments d ON d.service_id=t.service_id AND d.environment_id=r.environment_id;
--> statement-breakpoint
-- Reject unowned, unmappable, disabled or ambiguous targets instead of losing evidence.
CREATE TABLE `_deployment_resource_guard` (`valid` integer NOT NULL CHECK (`valid`=1));
--> statement-breakpoint
INSERT INTO `_deployment_resource_guard`
SELECT CASE WHEN
 (SELECT count(*) FROM resource_services)=(SELECT count(*) FROM `_deployment_resource_targets`) AND
 (SELECT count(*) FROM resources)=(SELECT count(DISTINCT resource_id) FROM `_deployment_resource_targets`) AND
 NOT EXISTS (SELECT 1 FROM `_deployment_resource_targets` WHERE enabled<>1)
 THEN 1 ELSE 0 END;
--> statement-breakpoint
INSERT INTO `_deployment_resource_guard`
SELECT CASE WHEN count(DISTINCT connection_id)=1 AND
 (kind<>'sls' OR count(DISTINCT json_array(json_extract(target_config,'$.region'),json_extract(target_config,'$.project')))=1) AND
 (kind<>'dms' OR (count(DISTINCT json_extract(target_config,'$.schemaName'))=count(*) AND count(DISTINCT json_extract(target_config,'$.databaseId'))=count(*)))
 THEN 1 ELSE 0 END
FROM `_deployment_resource_targets` GROUP BY deployment_id,kind;
--> statement-breakpoint
INSERT INTO `_deployment_resource_guard`
SELECT CASE WHEN json_type(d.config,'$.dms') IS NULL AND json_type(d.config,'$.sls') IS NULL THEN 1 ELSE 0 END
FROM service_deployments d WHERE EXISTS (SELECT 1 FROM `_deployment_resource_targets` t WHERE t.deployment_id=d.id);
--> statement-breakpoint
UPDATE service_deployments SET config=json_set(config,'$.dms',json_object(
 'connectionId',(SELECT connection_id FROM `_deployment_resource_targets` t WHERE t.deployment_id=service_deployments.id AND kind='dms' LIMIT 1),
 'databases',json((SELECT json_group_array(json(target_config)) FROM (SELECT target_config FROM `_deployment_resource_targets` t WHERE t.deployment_id=service_deployments.id AND kind='dms' ORDER BY name)))
)) WHERE EXISTS (SELECT 1 FROM `_deployment_resource_targets` t WHERE t.deployment_id=service_deployments.id AND kind='dms');
--> statement-breakpoint
UPDATE service_deployments SET config=json_set(config,'$.sls',json_object(
 'connectionId',(SELECT connection_id FROM `_deployment_resource_targets` t WHERE t.deployment_id=service_deployments.id AND kind='sls' LIMIT 1),
 'region',(SELECT json_extract(target_config,'$.region') FROM `_deployment_resource_targets` t WHERE t.deployment_id=service_deployments.id AND kind='sls' LIMIT 1),
 'project',(SELECT json_extract(target_config,'$.project') FROM `_deployment_resource_targets` t WHERE t.deployment_id=service_deployments.id AND kind='sls' LIMIT 1),
 'logstores',json((SELECT json_group_array(json_extract(target_config,'$.logstore')) FROM (SELECT target_config FROM `_deployment_resource_targets` t WHERE t.deployment_id=service_deployments.id AND kind='sls' ORDER BY name)))
)) WHERE EXISTS (SELECT 1 FROM `_deployment_resource_targets` t WHERE t.deployment_id=service_deployments.id AND kind='sls');
--> statement-breakpoint
UPDATE services SET description=description || CASE WHEN description<>'' THEN char(10) || char(10) ELSE '' END || '## 环境排查入口' || char(10) ||
 (SELECT group_concat(line,char(10)) FROM (SELECT '- [' || e.name || '] ' || t.name || CASE WHEN t.description<>'' THEN '：' || t.description ELSE '' END AS line FROM `_deployment_resource_targets` t JOIN service_deployments d ON d.id=t.deployment_id JOIN environments e ON e.id=d.environment_id WHERE d.service_id=services.id ORDER BY e.key,t.name))
WHERE EXISTS (SELECT 1 FROM `_deployment_resource_targets` t JOIN service_deployments d ON d.id=t.deployment_id WHERE d.service_id=services.id);
--> statement-breakpoint
UPDATE service_deployments SET config=json_set(config,'$.mcpServices',json((SELECT json_group_array(id) FROM (SELECT id FROM mcp_services ORDER BY name))))
WHERE EXISTS (SELECT 1 FROM mcp_services) AND environment_id IN (SELECT id FROM environments WHERE kind<>'dev');
--> statement-breakpoint
-- Development keeps code branches only; retain old values as private history.
UPDATE service_deployments SET config=json_object('archivedDevelopment',json(config))
WHERE environment_id IN (SELECT id FROM environments WHERE kind='dev') AND json(config)<>'{}';
--> statement-breakpoint
DROP TABLE resource_services;
--> statement-breakpoint
DROP TABLE resources;
--> statement-breakpoint
DROP TABLE `_deployment_resource_targets`;
--> statement-breakpoint
DROP TABLE `_deployment_resource_guard`;
