CREATE TEMP TABLE `_issue_resolution_state_check` (`valid` integer NOT NULL);
--> statement-breakpoint
CREATE TEMP TRIGGER `_issue_resolution_state_check_insert`
BEFORE INSERT ON `_issue_resolution_state_check`
WHEN NEW.`valid` <> 1
BEGIN
  SELECT RAISE(ABORT, 'issue_resolution_state_invalid');
END;
--> statement-breakpoint
INSERT INTO `_issue_resolution_state_check` (`valid`)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM `issues`
  WHERE (`status` = 'resolved') <> (`resolved_at` IS NOT NULL)
) THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TRIGGER `_issue_resolution_state_check_insert`;
--> statement-breakpoint
DROP TABLE `_issue_resolution_state_check`;
--> statement-breakpoint
CREATE TRIGGER `issues_resolution_state_insert`
BEFORE INSERT ON `issues`
WHEN (NEW.`status` = 'resolved') <> (NEW.`resolved_at` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'issue_resolution_state_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `issues_resolution_state_update`
BEFORE UPDATE OF `status`, `resolved_at` ON `issues`
WHEN (NEW.`status` = 'resolved') <> (NEW.`resolved_at` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'issue_resolution_state_invalid');
END;
