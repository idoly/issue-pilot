DELETE FROM `deployment_capabilities`
WHERE (`capability` = 'nacos' AND NOT EXISTS (
  SELECT 1 FROM `service_deployments` d WHERE d.`id` = `deployment_capabilities`.`deployment_id` AND json_type(d.`config`, '$.nacos') = 'object'
)) OR (`capability` = 'db' AND NOT EXISTS (
  SELECT 1 FROM `service_deployments` d WHERE d.`id` = `deployment_capabilities`.`deployment_id` AND json_type(d.`config`, '$.db') = 'object'
)) OR (`capability` = 'sls' AND NOT EXISTS (
  SELECT 1 FROM `service_deployments` d WHERE d.`id` = `deployment_capabilities`.`deployment_id` AND json_type(d.`config`, '$.sls.endpoint') = 'text' AND json_type(d.`config`, '$.sls.accessKeyId') = 'text' AND json_type(d.`config`, '$.sls.accessKeySecret') = 'text'
)) OR (`capability` = 'playwright' AND NOT EXISTS (
  SELECT 1 FROM `service_deployments` d WHERE d.`id` = `deployment_capabilities`.`deployment_id` AND json_type(d.`config`, '$.playwright') = 'object'
));
