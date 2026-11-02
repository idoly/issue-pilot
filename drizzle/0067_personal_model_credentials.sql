ALTER TABLE user_credentials ADD COLUMN model_credentials text;
--> statement-breakpoint
UPDATE user_credentials
SET model_credentials = (
  SELECT json_object('provider', g.provider, 'model', g.model, 'thinkingLevel', g.thinking_level, 'codemode', g.codemode,
    'apiKey', json_extract(user_credentials.model_api_keys, '$."' || g.provider || '"'))
  FROM global_agent_configuration g WHERE g.id = 1
),
revision = revision + 1
WHERE EXISTS (
  SELECT 1 FROM global_agent_configuration g
  WHERE g.id = 1 AND length(coalesce(json_extract(user_credentials.model_api_keys, '$."' || g.provider || '"'), '')) > 0
);
