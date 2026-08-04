UPDATE `issues`
SET `type` = 'question', `updated_at` = unixepoch() * 1000
WHERE `type` IN ('task', 'problem');
