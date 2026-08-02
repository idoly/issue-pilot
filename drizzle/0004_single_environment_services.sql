WITH ranked_service_environments AS (
  SELECT
    service_id,
    environment_id,
    row_number() OVER (
      PARTITION BY service_id
      ORDER BY
        CASE environments.kind
          WHEN 'production' THEN 1
          WHEN 'test' THEN 2
          ELSE 3
        END,
        service_environments.created_at,
        environment_id
    ) AS position
  FROM service_environments
  JOIN environments ON environments.id = service_environments.environment_id
)
DELETE FROM service_environments
USING ranked_service_environments
WHERE service_environments.service_id = ranked_service_environments.service_id
  AND service_environments.environment_id = ranked_service_environments.environment_id
  AND ranked_service_environments.position > 1;

CREATE UNIQUE INDEX service_environment_one_per_service
  ON service_environments (service_id);

UPDATE services
SET metadata = metadata - 'developmentStandards' - 'testStandards',
    updated_at = now()
WHERE metadata ? 'developmentStandards' OR metadata ? 'testStandards';
