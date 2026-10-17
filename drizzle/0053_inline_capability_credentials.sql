CREATE TABLE `_inline_credentials_guard` (`valid` integer NOT NULL CHECK (`valid`=1));
--> statement-breakpoint
INSERT INTO `_inline_credentials_guard`
SELECT CASE WHEN NOT EXISTS (
 SELECT 1 FROM service_deployments d, json_each(json_array(json(d.config),json_extract(d.config,'$.archivedDevelopment'))) scope, json_each(scope.value) section
 WHERE section.key IN ('dms','sls') AND json_extract(section.value,'$.connectionId') IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM resource_connections c WHERE c.id=json_extract(section.value,'$.connectionId') AND c.kind=section.key AND c.enabled=1)
) THEN 1 ELSE 0 END;
--> statement-breakpoint
INSERT INTO `_inline_credentials_guard`
SELECT CASE WHEN NOT EXISTS (
 SELECT 1 FROM resource_connections c WHERE NOT EXISTS (
  SELECT 1 FROM service_deployments d
  WHERE json_extract(d.config,'$.dms.connectionId')=c.id OR json_extract(d.config,'$.sls.connectionId')=c.id
  OR json_extract(d.config,'$.archivedDevelopment.dms.connectionId')=c.id OR json_extract(d.config,'$.archivedDevelopment.sls.connectionId')=c.id
 )
) THEN 1 ELSE 0 END;
--> statement-breakpoint
UPDATE service_deployments SET config=json_set(config,'$.dms',json_patch(json_remove(json_extract(config,'$.dms'),'$.connectionId'),json((SELECT config FROM resource_connections c WHERE c.id=json_extract(service_deployments.config,'$.dms.connectionId')))))
WHERE json_extract(config,'$.dms.connectionId') IS NOT NULL;
--> statement-breakpoint
UPDATE service_deployments SET config=json_set(config,'$.sls',json_patch(json_remove(json_extract(config,'$.sls'),'$.connectionId'),json((SELECT config FROM resource_connections c WHERE c.id=json_extract(service_deployments.config,'$.sls.connectionId')))))
WHERE json_extract(config,'$.sls.connectionId') IS NOT NULL;
--> statement-breakpoint
UPDATE service_deployments SET config=json_set(config,'$.archivedDevelopment.dms',json_patch(json_remove(json_extract(config,'$.archivedDevelopment.dms'),'$.connectionId'),json((SELECT config FROM resource_connections c WHERE c.id=json_extract(service_deployments.config,'$.archivedDevelopment.dms.connectionId')))))
WHERE json_extract(config,'$.archivedDevelopment.dms.connectionId') IS NOT NULL;
--> statement-breakpoint
UPDATE service_deployments SET config=json_set(config,'$.archivedDevelopment.sls',json_patch(json_remove(json_extract(config,'$.archivedDevelopment.sls'),'$.connectionId'),json((SELECT config FROM resource_connections c WHERE c.id=json_extract(service_deployments.config,'$.archivedDevelopment.sls.connectionId')))))
WHERE json_extract(config,'$.archivedDevelopment.sls.connectionId') IS NOT NULL;
--> statement-breakpoint
DROP TABLE resource_connections;
--> statement-breakpoint
DROP TABLE `_inline_credentials_guard`;
