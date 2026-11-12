-- DBHub targets in service_deployments.config remain authoritative.
-- Remove only the application-generated connection shape; explicit MCP rows remain intact.
DELETE FROM mcp_services
WHERE deployment_id IS NOT NULL
  AND length(id) = 30 AND substr(id, 1, 6) = 'dbhub-'
  AND substr(id, 7) NOT GLOB '*[^0-9a-f]*'
  AND name IN ('DBHub-mysql-' || substr(id, 7), 'DBHub-postgres-' || substr(id, 7), 'DBHub-mariadb-' || substr(id, 7), 'DBHub-sqlserver-' || substr(id, 7), 'DBHub-oracle-' || substr(id, 7))
  AND transport = 'stdio' AND enabled = 1 AND url = '' AND authorization = ''
  AND json_type(stdio, '$.env.DBHUB_DSN') = 'text'
  AND (SELECT count(*) FROM json_each(stdio, '$.env')) = 1
  AND (SELECT count(*) FROM json_each(stdio)) = 3
  AND json_extract(stdio, '$.args[1]') = '--transport'
  AND json_extract(stdio, '$.args[2]') = 'stdio'
  AND json_extract(stdio, '$.args[3]') = '--config'
  AND json_extract(stdio, '$.args[0]') LIKE '%/@bytebase/dbhub/dist/index.js'
  AND json_extract(stdio, '$.args[4]') LIKE '%/scripts/dbhub.toml'
  AND json_array_length(stdio, '$.args') = 5;
