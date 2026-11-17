-- Startup recovery and lifecycle SQL match these closed sets (src/domain/contracts.ts) literally.
-- Existing rows must already be valid; the guard does not coerce them.
CREATE TABLE __closed_domain_guard (valid integer NOT NULL CHECK (valid = 1));
--> statement-breakpoint
INSERT INTO __closed_domain_guard
SELECT 0 WHERE EXISTS (SELECT 1 FROM issues WHERE status NOT IN ('open', 'in_progress', 'pending', 'resolved'))
  OR EXISTS (SELECT 1 FROM issues WHERE priority NOT IN ('p0', 'p1', 'p2', 'p3'))
  OR EXISTS (SELECT 1 FROM issue_workspaces WHERE status NOT IN ('not_created', 'preparing', 'running', 'ready', 'stopped', 'failed'))
  OR EXISTS (SELECT 1 FROM environments WHERE kind NOT IN ('prod', 'test', 'dev'));
--> statement-breakpoint
DROP TABLE __closed_domain_guard;
--> statement-breakpoint
CREATE TRIGGER `issues_status_valid_insert` BEFORE INSERT ON `issues`
WHEN NEW.status NOT IN ('open', 'in_progress', 'pending', 'resolved')
BEGIN SELECT RAISE(ABORT, 'invalid_issue_status'); END;
--> statement-breakpoint
CREATE TRIGGER `issues_status_valid_update` BEFORE UPDATE OF `status` ON `issues`
WHEN NEW.status NOT IN ('open', 'in_progress', 'pending', 'resolved')
BEGIN SELECT RAISE(ABORT, 'invalid_issue_status'); END;
--> statement-breakpoint
CREATE TRIGGER `issues_priority_valid_insert` BEFORE INSERT ON `issues`
WHEN NEW.priority NOT IN ('p0', 'p1', 'p2', 'p3')
BEGIN SELECT RAISE(ABORT, 'invalid_issue_priority'); END;
--> statement-breakpoint
CREATE TRIGGER `issues_priority_valid_update` BEFORE UPDATE OF `priority` ON `issues`
WHEN NEW.priority NOT IN ('p0', 'p1', 'p2', 'p3')
BEGIN SELECT RAISE(ABORT, 'invalid_issue_priority'); END;
--> statement-breakpoint
CREATE TRIGGER `issue_workspaces_status_valid_insert` BEFORE INSERT ON `issue_workspaces`
WHEN NEW.status NOT IN ('not_created', 'preparing', 'running', 'ready', 'stopped', 'failed')
BEGIN SELECT RAISE(ABORT, 'invalid_workspace_status'); END;
--> statement-breakpoint
CREATE TRIGGER `issue_workspaces_status_valid_update` BEFORE UPDATE OF `status` ON `issue_workspaces`
WHEN NEW.status NOT IN ('not_created', 'preparing', 'running', 'ready', 'stopped', 'failed')
BEGIN SELECT RAISE(ABORT, 'invalid_workspace_status'); END;
--> statement-breakpoint
CREATE TRIGGER `environments_kind_valid_insert` BEFORE INSERT ON `environments`
WHEN NEW.kind NOT IN ('prod', 'test', 'dev')
BEGIN SELECT RAISE(ABORT, 'invalid_environment_kind'); END;
--> statement-breakpoint
CREATE TRIGGER `environments_kind_valid_update` BEFORE UPDATE OF `kind` ON `environments`
WHEN NEW.kind NOT IN ('prod', 'test', 'dev')
BEGIN SELECT RAISE(ABORT, 'invalid_environment_kind'); END;
--> statement-breakpoint
-- Mirrors service_deployments_issues_restrict_* (0035) for included services: a deployment that an Issue's
-- included service scope resolves through cannot disappear underneath it. Configuration writes already refuse this.
CREATE TRIGGER `service_deployments_included_issues_restrict_update`
BEFORE UPDATE OF `service_id`, `environment_id` ON `service_deployments`
WHEN (NEW.`service_id` <> OLD.`service_id` OR NEW.`environment_id` <> OLD.`environment_id`) AND EXISTS (
  SELECT 1 FROM `issue_service_scopes` AS s JOIN `issues` AS i ON i.`id` = s.`issue_id`
  WHERE s.`service_id` = OLD.`service_id` AND i.`environment_id` = OLD.`environment_id`
)
BEGIN
  SELECT RAISE(ABORT, 'deployment_is_used_by_issues');
END;
--> statement-breakpoint
CREATE TRIGGER `service_deployments_included_issues_restrict_delete`
BEFORE DELETE ON `service_deployments`
WHEN EXISTS (
  SELECT 1 FROM `issue_service_scopes` AS s JOIN `issues` AS i ON i.`id` = s.`issue_id`
  WHERE s.`service_id` = OLD.`service_id` AND i.`environment_id` = OLD.`environment_id`
)
BEGIN
  SELECT RAISE(ABORT, 'deployment_is_used_by_issues');
END;
