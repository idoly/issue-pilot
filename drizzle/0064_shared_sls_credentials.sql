ALTER TABLE application_settings ADD COLUMN shared_sls_credentials text;
--> statement-breakpoint
ALTER TABLE application_settings ADD COLUMN shared_sls_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE __shared_sls_migration_guard (credential_groups integer NOT NULL CHECK (credential_groups <= 1));
--> statement-breakpoint
INSERT INTO __shared_sls_migration_guard
SELECT 2 WHERE EXISTS (
  SELECT 1 FROM service_deployments
  WHERE json_type(config, '$.sls') = 'object'
    AND (json_extract(config, '$.sls.accessKeyId') IS NOT NULL OR json_extract(config, '$.sls.accessKeySecret') IS NOT NULL)
    AND (coalesce(length(trim(json_extract(config, '$.sls.accessKeyId'))), 0) = 0
      OR coalesce(length(trim(json_extract(config, '$.sls.accessKeySecret'))), 0) = 0)
);
--> statement-breakpoint
INSERT INTO __shared_sls_migration_guard
SELECT count(DISTINCT json_object('accessKeyId', json_extract(config, '$.sls.accessKeyId'), 'accessKeySecret', json_extract(config, '$.sls.accessKeySecret')))
FROM service_deployments
WHERE json_type(config, '$.sls') = 'object'
  AND (json_extract(config, '$.sls.accessKeyId') IS NOT NULL OR json_extract(config, '$.sls.accessKeySecret') IS NOT NULL);
--> statement-breakpoint
INSERT INTO application_settings (id)
SELECT 1 WHERE EXISTS (
  SELECT 1 FROM service_deployments
  WHERE json_type(config, '$.sls') = 'object'
    AND json_extract(config, '$.sls.accessKeyId') IS NOT NULL
    AND json_extract(config, '$.sls.accessKeySecret') IS NOT NULL
) ON CONFLICT(id) DO NOTHING;
--> statement-breakpoint
UPDATE application_settings
SET shared_sls_credentials = (
  SELECT json_object('accessKeyId', json_extract(config, '$.sls.accessKeyId'), 'accessKeySecret', json_extract(config, '$.sls.accessKeySecret'))
  FROM service_deployments
  WHERE json_type(config, '$.sls') = 'object'
    AND json_extract(config, '$.sls.accessKeyId') IS NOT NULL
    AND json_extract(config, '$.sls.accessKeySecret') IS NOT NULL
  LIMIT 1
)
WHERE id = 1;
--> statement-breakpoint
UPDATE services SET revision = revision + 1
WHERE id IN (
  SELECT service_id FROM service_deployments
  WHERE json_type(config, '$.sls') = 'object'
    AND (json_extract(config, '$.sls.accessKeyId') IS NOT NULL OR json_extract(config, '$.sls.accessKeySecret') IS NOT NULL)
);
--> statement-breakpoint
UPDATE service_deployments
SET config = json_remove(config, '$.sls.accessKeyId', '$.sls.accessKeySecret')
WHERE json_type(config, '$.sls') = 'object';
--> statement-breakpoint
DROP TABLE __shared_sls_migration_guard;
