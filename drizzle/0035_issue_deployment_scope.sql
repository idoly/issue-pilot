CREATE TRIGGER `issues_deployment_required_insert`
BEFORE INSERT ON `issues`
WHEN NEW.`service_id` IS NOT NULL AND NEW.`environment_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `service_deployments`
  WHERE `service_id` = NEW.`service_id` AND `environment_id` = NEW.`environment_id`
)
BEGIN
  SELECT RAISE(ABORT, 'issue_deployment_required');
END;
--> statement-breakpoint
CREATE TRIGGER `issues_deployment_required_update`
BEFORE UPDATE OF `service_id`, `environment_id` ON `issues`
WHEN NEW.`service_id` IS NOT NULL AND NEW.`environment_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `service_deployments`
  WHERE `service_id` = NEW.`service_id` AND `environment_id` = NEW.`environment_id`
)
BEGIN
  SELECT RAISE(ABORT, 'issue_deployment_required');
END;
--> statement-breakpoint
CREATE TRIGGER `service_deployments_issues_restrict_update`
BEFORE UPDATE OF `service_id`, `environment_id` ON `service_deployments`
WHEN (NEW.`service_id` <> OLD.`service_id` OR NEW.`environment_id` <> OLD.`environment_id`) AND EXISTS (
  SELECT 1 FROM `issues`
  WHERE `service_id` = OLD.`service_id` AND `environment_id` = OLD.`environment_id`
)
BEGIN
  SELECT RAISE(ABORT, 'deployment_is_used_by_issues');
END;
--> statement-breakpoint
CREATE TRIGGER `service_deployments_issues_restrict_delete`
BEFORE DELETE ON `service_deployments`
WHEN EXISTS (
  SELECT 1 FROM `issues`
  WHERE `service_id` = OLD.`service_id` AND `environment_id` = OLD.`environment_id`
)
BEGIN
  SELECT RAISE(ABORT, 'deployment_is_used_by_issues');
END;
