UPDATE `service_deployments`
SET `config` = json_set(`config`, '$.nacos.username', '')
WHERE json_type(`config`, '$.nacos') = 'object'
  AND json_type(`config`, '$.nacos.username') IS NULL;

UPDATE `service_deployments`
SET `config` = json_set(`config`, '$.redis.username', '')
WHERE json_type(`config`, '$.redis') = 'object'
  AND json_type(`config`, '$.redis.username') IS NULL;

UPDATE `service_deployments`
SET `config` = json_set(`config`, '$.es.username', '')
WHERE json_type(`config`, '$.es') = 'object'
  AND json_type(`config`, '$.es.username') IS NULL;

DELETE FROM `deployment_capabilities`
WHERE (`capability` = 'nacos' AND NOT EXISTS (
  SELECT 1 FROM `service_deployments` d
  WHERE d.`id` = `deployment_capabilities`.`deployment_id`
    AND json_type(d.`config`, '$.nacos.serverUrl') = 'text'
    AND json_type(d.`config`, '$.nacos.namespace') = 'text'
    AND json_type(d.`config`, '$.nacos.group') = 'text'
    AND json_type(d.`config`, '$.nacos.username') = 'text'
    AND (coalesce(json_extract(d.`config`, '$.nacos.username'), '') = '' OR json_type(d.`config`, '$.nacos.password') = 'text')
)) OR (`capability` = 'db' AND NOT EXISTS (
  SELECT 1 FROM `service_deployments` d
  WHERE d.`id` = `deployment_capabilities`.`deployment_id`
    AND json_type(d.`config`, '$.db.url') = 'text'
    AND json_type(d.`config`, '$.db.username') = 'text'
    AND json_type(d.`config`, '$.db.password') = 'text'
)) OR (`capability` = 'sls' AND NOT EXISTS (
  SELECT 1 FROM `service_deployments` d
  WHERE d.`id` = `deployment_capabilities`.`deployment_id`
    AND json_type(d.`config`, '$.sls.accessKeyId') = 'text'
    AND json_type(d.`config`, '$.sls.accessKeySecret') = 'text'
    AND json_type(d.`config`, '$.sls.region') = 'text'
    AND json_type(d.`config`, '$.sls.project') = 'text'
    AND json_type(d.`config`, '$.sls.logstores') = 'array'
    AND json_array_length(d.`config`, '$.sls.logstores') > 0
)) OR (`capability` = 'playwright' AND NOT EXISTS (
  SELECT 1 FROM `service_deployments` d
  WHERE d.`id` = `deployment_capabilities`.`deployment_id`
    AND json_type(d.`config`, '$.playwright.baseUrl') = 'text'
    AND (coalesce(json_extract(d.`config`, '$.playwright.username'), '') = '' OR json_type(d.`config`, '$.playwright.password') = 'text')
)) OR (`capability` = 'redis' AND NOT EXISTS (
  SELECT 1 FROM `service_deployments` d
  WHERE d.`id` = `deployment_capabilities`.`deployment_id`
    AND json_type(d.`config`, '$.redis.host') = 'text'
    AND json_type(d.`config`, '$.redis.port') = 'integer'
    AND json_type(d.`config`, '$.redis.database') = 'integer'
    AND (coalesce(json_extract(d.`config`, '$.redis.username'), '') = '' OR json_type(d.`config`, '$.redis.password') = 'text')
)) OR (`capability` = 'mq' AND NOT EXISTS (
  SELECT 1 FROM `service_deployments` d
  WHERE d.`id` = `deployment_capabilities`.`deployment_id`
    AND json_type(d.`config`, '$.mq.host') = 'text'
    AND json_type(d.`config`, '$.mq.port') = 'integer'
    AND json_type(d.`config`, '$.mq.managementPort') = 'integer'
    AND json_type(d.`config`, '$.mq.username') = 'text'
    AND json_type(d.`config`, '$.mq.password') = 'text'
    AND json_type(d.`config`, '$.mq.virtualHost') = 'text'
)) OR (`capability` = 'es' AND NOT EXISTS (
  SELECT 1 FROM `service_deployments` d
  WHERE d.`id` = `deployment_capabilities`.`deployment_id`
    AND json_type(d.`config`, '$.es.url') = 'text'
    AND (coalesce(json_extract(d.`config`, '$.es.username'), '') = '' OR json_type(d.`config`, '$.es.password') = 'text')
));
