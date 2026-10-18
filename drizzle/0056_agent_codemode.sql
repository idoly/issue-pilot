ALTER TABLE `global_agent_configuration` ADD COLUMN `codemode` text NOT NULL DEFAULT 'on' CHECK (`codemode` IN ('off','on','only'));
