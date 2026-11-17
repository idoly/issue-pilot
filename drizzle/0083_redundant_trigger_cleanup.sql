-- issues_type_valid_* (0070) already rejects everything outside the Issue type enum, so the
-- retired 'data_processing' pair from 0062 is redundant. Keep all other triggers.
DROP TRIGGER `issues_retired_type_insert`;
--> statement-breakpoint
DROP TRIGGER `issues_retired_type_update`;
--> statement-breakpoint
-- Existing rows must already use the closed work-mode set (src/domain/contracts.ts).
CREATE TABLE `__issue_work_mode_guard` (`valid` integer NOT NULL CHECK (`valid` = 1));
--> statement-breakpoint
INSERT INTO `__issue_work_mode_guard`
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM `issue_scope_transitions`
  WHERE `from_work_mode` NOT IN ('production_analysis', 'test_analysis', 'development_fix', 'development_feature')
     OR `to_work_mode` NOT IN ('production_analysis', 'test_analysis', 'development_fix', 'development_feature')
);
--> statement-breakpoint
DROP TABLE `__issue_work_mode_guard`;
--> statement-breakpoint
DROP TRIGGER `scope_transitions_retired_mode_insert`;
--> statement-breakpoint
DROP TRIGGER `scope_transitions_retired_mode_update`;
--> statement-breakpoint
CREATE TRIGGER `issue_scope_transitions_work_mode_valid_insert` BEFORE INSERT ON `issue_scope_transitions`
WHEN NEW.`from_work_mode` NOT IN ('production_analysis', 'test_analysis', 'development_fix', 'development_feature')
  OR NEW.`to_work_mode` NOT IN ('production_analysis', 'test_analysis', 'development_fix', 'development_feature')
BEGIN SELECT RAISE(ABORT, 'invalid_issue_work_mode'); END;
--> statement-breakpoint
CREATE TRIGGER `issue_scope_transitions_work_mode_valid_update` BEFORE UPDATE OF `from_work_mode`, `to_work_mode` ON `issue_scope_transitions`
WHEN NEW.`from_work_mode` NOT IN ('production_analysis', 'test_analysis', 'development_fix', 'development_feature')
  OR NEW.`to_work_mode` NOT IN ('production_analysis', 'test_analysis', 'development_fix', 'development_feature')
BEGIN SELECT RAISE(ABORT, 'invalid_issue_work_mode'); END;
