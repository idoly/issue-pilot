UPDATE `service_deployments`
SET `config` = json_remove(json_set(`config`, '$.playwright', json_extract(`config`, '$.browser')), '$.browser')
WHERE json_type(`config`, '$.browser') = 'object' AND json_type(`config`, '$.playwright') IS NULL;
