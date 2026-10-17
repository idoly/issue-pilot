CREATE TABLE `resource_connections` (
 `id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `kind` text NOT NULL CHECK (`kind` IN ('dms','sls')),
 `config` text NOT NULL, `enabled` integer NOT NULL DEFAULT 1, `created_at` integer NOT NULL, `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resource_connection_name_unique` ON `resource_connections` (`name`);
--> statement-breakpoint
CREATE TABLE `resources` (
 `id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `description` text NOT NULL DEFAULT '',
 `connection_id` text NOT NULL REFERENCES `resource_connections` (`id`),
 `environment_id` text NOT NULL REFERENCES `environments` (`id`),
 `config` text NOT NULL, `enabled` integer NOT NULL DEFAULT 1, `created_at` integer NOT NULL, `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resource_name_unique` ON `resources` (`name`);
--> statement-breakpoint
CREATE INDEX `resources_environment_idx` ON `resources` (`environment_id`);
--> statement-breakpoint
CREATE TABLE `resource_services` (
 `resource_id` text NOT NULL REFERENCES `resources` (`id`) ON DELETE CASCADE,
 `service_id` text NOT NULL REFERENCES `services` (`id`) ON DELETE CASCADE,
 PRIMARY KEY (`resource_id`,`service_id`)
);
--> statement-breakpoint
CREATE TABLE `_resource_import` (`kind` text, `service_id` text, `environment_id` text, `connection_config` text, `target_config` text, `name` text, `created_at` integer, `updated_at` integer);
--> statement-breakpoint
INSERT INTO `_resource_import`
SELECT 'dms', d.service_id, d.environment_id,
 json_object('url',json_extract(d.config,'$.dms.url'),'authorization',json_extract(d.config,'$.dms.authorization')),
 json_object('instanceAlias',json_extract(j.value,'$.instanceAlias'),'schemaName',json_extract(j.value,'$.schemaName'),'instanceId',json_extract(j.value,'$.instanceId'),'instanceHost',json_extract(j.value,'$.instanceHost'),'instancePort',json_extract(j.value,'$.instancePort'),'databaseId',json_extract(j.value,'$.databaseId')),
 'dms:' || s.key || ':' || e.key || ':' || json_extract(j.value,'$.schemaName'), d.created_at, d.updated_at
FROM service_deployments d JOIN services s ON s.id=d.service_id JOIN environments e ON e.id=d.environment_id, json_each(d.config,'$.dms.databases') j
WHERE json_type(d.config,'$.dms')='object';
--> statement-breakpoint
INSERT INTO `_resource_import`
SELECT 'sls', d.service_id, d.environment_id,
 json_object('accessKeyId',json_extract(d.config,'$.sls.accessKeyId'),'accessKeySecret',json_extract(d.config,'$.sls.accessKeySecret')),
 json_object('region',json_extract(d.config,'$.sls.region'),'project',json_extract(d.config,'$.sls.project'),'logstore',j.value),
 'sls:' || s.key || ':' || e.key || ':' || j.value, d.created_at, d.updated_at
FROM service_deployments d JOIN services s ON s.id=d.service_id JOIN environments e ON e.id=d.environment_id, json_each(d.config,'$.sls.logstores') j
WHERE json_type(d.config,'$.sls')='object';
--> statement-breakpoint
CREATE TABLE `_resource_import_guard` (`valid` integer NOT NULL CHECK (`valid`=1));
--> statement-breakpoint
INSERT INTO `_resource_import_guard`
SELECT CASE WHEN
 (kind='dms' AND coalesce(json_extract(connection_config,'$.url'),'')<>'' AND coalesce(json_extract(connection_config,'$.authorization'),'')<>'' AND coalesce(json_extract(target_config,'$.databaseId'),'')<>'' AND coalesce(json_extract(target_config,'$.schemaName'),'')<>'')
 OR (kind='sls' AND coalesce(json_extract(connection_config,'$.accessKeyId'),'')<>'' AND coalesce(json_extract(connection_config,'$.accessKeySecret'),'')<>'' AND coalesce(json_extract(target_config,'$.region'),'')<>'' AND coalesce(json_extract(target_config,'$.project'),'')<>'' AND coalesce(json_extract(target_config,'$.logstore'),'')<>'')
 THEN 1 ELSE 0 END FROM `_resource_import`;
--> statement-breakpoint
INSERT INTO `_resource_import_guard`
SELECT CASE WHEN
 (json_type(config,'$.dms') IS NULL OR (json_type(config,'$.dms.databases')='array' AND json_array_length(config,'$.dms.databases')>0)) AND
 (json_type(config,'$.sls') IS NULL OR (json_type(config,'$.sls.logstores')='array' AND json_array_length(config,'$.sls.logstores')>0))
 THEN 1 ELSE 0 END FROM service_deployments;
--> statement-breakpoint
DROP TABLE `_resource_import_guard`;
--> statement-breakpoint
INSERT INTO resource_connections (id,name,kind,config,enabled,created_at,updated_at)
SELECT lower(hex(randomblob(16))), upper(kind) || ' ' || row_number() OVER (PARTITION BY kind ORDER BY connection_config), kind, connection_config, 1, min(created_at), max(updated_at)
FROM `_resource_import` GROUP BY kind,connection_config;
--> statement-breakpoint
INSERT INTO resources (id,name,description,connection_id,environment_id,config,enabled,created_at,updated_at)
SELECT lower(hex(randomblob(16))), min(i.name), '', c.id, i.environment_id, i.target_config, 1, min(i.created_at), max(i.updated_at)
FROM `_resource_import` i JOIN resource_connections c ON c.kind=i.kind AND c.config=i.connection_config
GROUP BY c.id,i.environment_id,i.target_config;
--> statement-breakpoint
INSERT INTO resource_services (resource_id,service_id)
SELECT DISTINCT r.id,i.service_id FROM `_resource_import` i
JOIN resource_connections c ON c.kind=i.kind AND c.config=i.connection_config
JOIN resources r ON r.connection_id=c.id AND r.environment_id=i.environment_id AND r.config=i.target_config;
--> statement-breakpoint
DROP TABLE `_resource_import`;
--> statement-breakpoint
UPDATE service_deployments SET config=json_remove(config,'$.dms','$.sls') WHERE json_type(config,'$.dms') IS NOT NULL OR json_type(config,'$.sls') IS NOT NULL;
