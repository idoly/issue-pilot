DELETE FROM `deployment_capabilities`
WHERE `capability` NOT IN ('configuration_read', 'database_read');
