UPDATE `service_deployments`
SET `config` = json_set(
  `config`,
  '$.dms.databases',
  json((
    SELECT json_group_array(json_remove(`value`, '$.name'))
    FROM json_each(`service_deployments`.`config`, '$.dms.databases')
  ))
)
WHERE json_type(`config`, '$.dms.databases') = 'array';
