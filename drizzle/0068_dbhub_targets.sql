-- Retire the MySQL input layout, without choosing between conflicting settings
-- or changing historical/unknown MCP commands on the operator's behalf.
CREATE TABLE __dbhub_migration_guard (valid integer NOT NULL CHECK (valid = 1));
--> statement-breakpoint
INSERT INTO __dbhub_migration_guard
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM service_deployments
  WHERE json_type(config, '$.mysql') IS NOT NULL
    AND (json_type(config, '$.mysql') <> 'array' OR json_type(config, '$.dbhub') IS NOT NULL)
) OR EXISTS (
  SELECT 1 FROM mcp_services WHERE deployment_id IS NOT NULL AND substr(id, 1, 6) = 'mysql-'
);
--> statement-breakpoint
INSERT INTO __dbhub_migration_guard
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM service_deployments d, json_each(d.config, '$.mysql') t
  WHERE t.type <> 'object'
) OR EXISTS (
  SELECT 1 FROM service_deployments d JOIN environments e ON e.id = d.environment_id
  WHERE e.kind = 'dev' AND json_array_length(d.config, '$.mysql') > 0
);
--> statement-breakpoint
INSERT INTO __dbhub_migration_guard
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM service_deployments d, json_each(d.config, '$.mysql') t
  WHERE json_type(t.value, '$.host') IS NOT 'text'
    OR length(trim(json_extract(t.value, '$.host'))) NOT BETWEEN 1 AND 255
    OR json_extract(t.value, '$.host') GLOB '*[ /\@?#]*'
    OR instr(json_extract(t.value, '$.host'), char(0)) > 0
    OR instr(json_extract(t.value, '$.host'), char(9)) > 0
    OR instr(json_extract(t.value, '$.host'), char(10)) > 0
    OR instr(json_extract(t.value, '$.host'), char(13)) > 0
    OR json_type(t.value, '$.port') IS NOT 'integer'
    OR json_extract(t.value, '$.port') NOT BETWEEN 1 AND 65535
    OR json_type(t.value, '$.username') IS NOT 'text'
    OR length(trim(json_extract(t.value, '$.username'))) NOT BETWEEN 1 AND 255
    OR json_type(t.value, '$.password') IS NOT 'text'
    OR length(json_extract(t.value, '$.password')) = 0
    OR instr(json_extract(t.value, '$.password'), char(0)) > 0
    OR json_type(t.value, '$.database') IS NOT 'text'
    OR length(trim(json_extract(t.value, '$.database'))) NOT BETWEEN 1 AND 255
    OR EXISTS (SELECT 1 FROM json_each(t.value) WHERE key NOT IN ('host', 'port', 'username', 'password', 'database'))
) OR EXISTS (
  SELECT 1 FROM service_deployments d, json_each(d.config, '$.mysql') t
  GROUP BY d.id, json_extract(t.value, '$.host'), json_extract(t.value, '$.port'), json_extract(t.value, '$.database')
  HAVING count(*) > 1
);
--> statement-breakpoint
UPDATE services SET revision = revision + 1
WHERE id IN (SELECT service_id FROM service_deployments WHERE json_type(config, '$.mysql') IS NOT NULL);
--> statement-breakpoint
UPDATE service_deployments
SET config = CASE WHEN json_array_length(config, '$.mysql') = 0 THEN json_remove(config, '$.mysql')
  ELSE json_set(json_remove(config, '$.mysql'), '$.dbhub', (
    SELECT json_group_array(json_set(value, '$.type', 'mysql')) FROM json_each(service_deployments.config, '$.mysql')
  )) END
WHERE json_type(config, '$.mysql') IS NOT NULL;
--> statement-breakpoint
DROP TABLE __dbhub_migration_guard;
