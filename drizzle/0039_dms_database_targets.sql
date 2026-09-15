CREATE TABLE `_dms_database_targets_guard` (
  `valid` integer NOT NULL CHECK (`valid` = 1)
);
--> statement-breakpoint
INSERT INTO `_dms_database_targets_guard` (`valid`)
SELECT CASE WHEN
  coalesce(json_extract(`config`, '$.dms.instanceId'), '') <> '' AND
  coalesce(json_extract(`config`, '$.dms.instanceHost'), '') <> '' AND
  coalesce(json_extract(`config`, '$.dms.instancePort'), '') <> '' AND
  coalesce(json_extract(`config`, '$.dms.instanceLabel'), '') <> '' AND
  coalesce(json_extract(`config`, '$.dms.databaseId'), '') <> '' AND
  coalesce(json_extract(`config`, '$.dms.databaseLabel'), '') <> ''
THEN 1 ELSE 0 END
FROM `service_deployments`
WHERE json_type(`config`, '$.dms') = 'object';
--> statement-breakpoint
DROP TABLE `_dms_database_targets_guard`;
--> statement-breakpoint
UPDATE `service_deployments`
SET `config` = json_set(
  json_remove(
    `config`,
    '$.dms.instanceId',
    '$.dms.instanceHost',
    '$.dms.instancePort',
    '$.dms.instanceLabel',
    '$.dms.databaseId',
    '$.dms.databaseLabel'
  ),
  '$.dms.databases',
  json_array(json_object(
    'name', json_extract(`config`, '$.dms.databaseLabel'),
    'instanceAlias', CASE
      WHEN instr(json_extract(`config`, '$.dms.instanceLabel'), ' · ') > 0
      THEN substr(json_extract(`config`, '$.dms.instanceLabel'), 1, instr(json_extract(`config`, '$.dms.instanceLabel'), ' · ') - 1)
      ELSE json_extract(`config`, '$.dms.instanceLabel')
    END,
    'schemaName', json_extract(`config`, '$.dms.databaseLabel'),
    'instanceId', json_extract(`config`, '$.dms.instanceId'),
    'instanceHost', json_extract(`config`, '$.dms.instanceHost'),
    'instancePort', json_extract(`config`, '$.dms.instancePort'),
    'databaseId', json_extract(`config`, '$.dms.databaseId')
  ))
)
WHERE json_type(`config`, '$.dms') = 'object';
