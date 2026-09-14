UPDATE `issues` SET `type` = CASE `type`
  WHEN 'incident' THEN 'defect_fix'
  WHEN 'request' THEN 'feature_development'
  WHEN 'question' THEN 'smart_analysis'
  ELSE `type`
END,
`updated_at` = unixepoch() * 1000
WHERE `type` IN ('incident', 'request', 'question');
