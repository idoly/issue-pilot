CREATE TRIGGER `issues_scope_required_insert`
BEFORE INSERT ON `issues`
WHEN NEW.`service_id` IS NULL OR NEW.`environment_id` IS NULL
BEGIN
  SELECT RAISE(ABORT, 'issue_scope_required');
END;
--> statement-breakpoint
CREATE TRIGGER `issues_scope_required_update`
BEFORE UPDATE OF `service_id`, `environment_id` ON `issues`
WHEN NEW.`service_id` IS NULL OR NEW.`environment_id` IS NULL
BEGIN
  SELECT RAISE(ABORT, 'issue_scope_required');
END;
