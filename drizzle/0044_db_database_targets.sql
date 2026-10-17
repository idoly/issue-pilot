CREATE TABLE `_db_database_targets_guard` (
  `valid` integer NOT NULL CHECK (`valid` = 1)
);
--> statement-breakpoint
INSERT INTO `_db_database_targets_guard` (`valid`)
SELECT CASE WHEN
  json_type(`config`, '$.db.url') = 'text' AND
  coalesce(json_extract(`config`, '$.db.url'), '') <> '' AND
  json_type(`config`, '$.db.username') = 'text' AND
  coalesce(json_extract(`config`, '$.db.username'), '') <> '' AND
  json_type(`config`, '$.db.password') = 'text' AND
  coalesce(json_extract(`config`, '$.db.password'), '') <> '' AND
  json_type(`config`, '$.db.databases') IS NULL
THEN 1 ELSE 0 END
FROM `service_deployments`
WHERE json_type(`config`, '$.db') = 'object';
--> statement-breakpoint
DROP TABLE `_db_database_targets_guard`;
--> statement-breakpoint
UPDATE `service_deployments`
SET `config` = json_set(
  json_remove(`config`, '$.db.url', '$.db.username', '$.db.password'),
  '$.db.databases',
  json_array(json_object(
    'url', json_extract(`config`, '$.db.url'),
    'username', json_extract(`config`, '$.db.username'),
    'password', json_extract(`config`, '$.db.password')
  ))
)
WHERE json_type(`config`, '$.db') = 'object';
