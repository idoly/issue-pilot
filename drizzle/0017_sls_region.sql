UPDATE `service_deployments`
SET `config` = json_remove(
  json_set(
    `config`,
    '$.sls.region',
    substr(
      replace(replace(json_extract(`config`, '$.sls.endpoint'), 'https://', ''), 'http://', ''),
      1,
      instr(replace(replace(json_extract(`config`, '$.sls.endpoint'), 'https://', ''), 'http://', ''), '.log.') - 1
    )
  ),
  '$.sls.endpoint'
)
WHERE json_type(`config`, '$.sls.endpoint') = 'text'
  AND json_type(`config`, '$.sls.region') IS NULL
  AND instr(replace(replace(json_extract(`config`, '$.sls.endpoint'), 'https://', ''), 'http://', ''), '.log.') > 1;
