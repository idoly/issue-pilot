-- SLS query identity is region/project/logstore, never a user-defined target name.
-- Only current deployment configuration changes; private historical JSON is not rewritten.
UPDATE services
SET revision = revision + 1, updated_at = unixepoch()
WHERE id IN (
  SELECT d.service_id FROM service_deployments AS d
  WHERE EXISTS (
    SELECT 1 FROM json_each(d.config, '$.sls.targets') AS t
    WHERE json_type(t.value, '$.name') IS NOT NULL
  )
);
--> statement-breakpoint
UPDATE service_deployments AS d
SET config = json_set(
  d.config,
  '$.sls.targets',
  json((SELECT json_group_array(json_remove(t.value, '$.name')) FROM json_each(d.config, '$.sls.targets') AS t))
), updated_at = unixepoch()
WHERE EXISTS (
  SELECT 1 FROM json_each(d.config, '$.sls.targets') AS t
  WHERE json_type(t.value, '$.name') IS NOT NULL
);
