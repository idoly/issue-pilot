UPDATE `deployment_capabilities`
SET `capability` = CASE `capability`
  WHEN 'configuration_read' THEN 'nacos'
  WHEN 'database_read' THEN 'db'
  WHEN 'sls_read' THEN 'sls'
  WHEN 'browser_use' THEN 'playwright'
  ELSE `capability`
END
WHERE `capability` IN ('configuration_read', 'database_read', 'sls_read', 'browser_use');
