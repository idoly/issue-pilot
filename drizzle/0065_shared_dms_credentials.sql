ALTER TABLE application_settings ADD COLUMN shared_dms_credentials text;
--> statement-breakpoint
ALTER TABLE application_settings ADD COLUMN shared_dms_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE __shared_dms_migration_guard (credential_groups integer NOT NULL CHECK (credential_groups <= 1));
--> statement-breakpoint
INSERT INTO __shared_dms_migration_guard
SELECT 2 WHERE EXISTS (
  SELECT 1 FROM service_deployments
  WHERE json_type(config, '$.dms') = 'object'
    AND (json_extract(config, '$.dms.url') IS NOT NULL OR json_extract(config, '$.dms.authorization') IS NOT NULL)
    AND (coalesce(length(trim(json_extract(config, '$.dms.url'))), 0) = 0
      OR coalesce(length(trim(json_extract(config, '$.dms.authorization'))), 0) = 0)
);
--> statement-breakpoint
INSERT INTO __shared_dms_migration_guard
SELECT count(DISTINCT json_object('url', json_extract(config, '$.dms.url'), 'authorization', json_extract(config, '$.dms.authorization')))
FROM service_deployments
WHERE json_type(config, '$.dms') = 'object'
  AND (json_extract(config, '$.dms.url') IS NOT NULL OR json_extract(config, '$.dms.authorization') IS NOT NULL);
--> statement-breakpoint
INSERT INTO application_settings (id)
SELECT 1 WHERE EXISTS (
  SELECT 1 FROM service_deployments
  WHERE json_type(config, '$.dms') = 'object'
    AND json_extract(config, '$.dms.url') IS NOT NULL
    AND json_extract(config, '$.dms.authorization') IS NOT NULL
) ON CONFLICT(id) DO NOTHING;
--> statement-breakpoint
UPDATE application_settings
SET shared_dms_credentials = (
  SELECT json_object('url', json_extract(config, '$.dms.url'), 'authorization', json_extract(config, '$.dms.authorization'))
  FROM service_deployments
  WHERE json_type(config, '$.dms') = 'object'
    AND json_extract(config, '$.dms.url') IS NOT NULL
    AND json_extract(config, '$.dms.authorization') IS NOT NULL
  LIMIT 1
)
WHERE id = 1;
--> statement-breakpoint
UPDATE services SET revision = revision + 1
WHERE id IN (
  SELECT service_id FROM service_deployments
  WHERE json_type(config, '$.dms') = 'object'
    AND (json_extract(config, '$.dms.url') IS NOT NULL OR json_extract(config, '$.dms.authorization') IS NOT NULL)
);
--> statement-breakpoint
UPDATE service_deployments
SET config = json_remove(config, '$.dms.url', '$.dms.authorization')
WHERE json_type(config, '$.dms') = 'object';
--> statement-breakpoint
DROP TABLE __shared_dms_migration_guard;
