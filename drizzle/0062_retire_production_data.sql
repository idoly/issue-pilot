UPDATE `issues` SET `type` = 'smart_analysis' WHERE `type` = 'data_processing';
--> statement-breakpoint
UPDATE `issue_scope_transitions` SET `from_work_mode` = 'production_analysis' WHERE `from_work_mode` = 'production_data';
--> statement-breakpoint
UPDATE `issue_scope_transitions` SET `to_work_mode` = 'production_analysis' WHERE `to_work_mode` = 'production_data';
--> statement-breakpoint
CREATE TRIGGER `issues_retired_type_insert` BEFORE INSERT ON `issues`
WHEN NEW.type = 'data_processing'
BEGIN SELECT RAISE(ABORT, 'retired_issue_type'); END;
--> statement-breakpoint
CREATE TRIGGER `issues_retired_type_update` BEFORE UPDATE OF `type` ON `issues`
WHEN NEW.type = 'data_processing'
BEGIN SELECT RAISE(ABORT, 'retired_issue_type'); END;
--> statement-breakpoint
CREATE TRIGGER `scope_transitions_retired_mode_insert` BEFORE INSERT ON `issue_scope_transitions`
WHEN NEW.from_work_mode = 'production_data' OR NEW.to_work_mode = 'production_data'
BEGIN SELECT RAISE(ABORT, 'retired_issue_work_mode'); END;
--> statement-breakpoint
CREATE TRIGGER `scope_transitions_retired_mode_update` BEFORE UPDATE OF `from_work_mode`, `to_work_mode` ON `issue_scope_transitions`
WHEN NEW.from_work_mode = 'production_data' OR NEW.to_work_mode = 'production_data'
BEGIN SELECT RAISE(ABORT, 'retired_issue_work_mode'); END;
