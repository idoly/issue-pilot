-- Check the old state once before using targeted recovery on ordinary restarts.
CREATE TEMP TABLE `_issue_recovery_state_check` (`valid` integer NOT NULL CONSTRAINT issue_recovery_state_invalid CHECK (`valid` = 1));
--> statement-breakpoint
INSERT INTO `_issue_recovery_state_check` (`valid`)
SELECT NOT EXISTS (
  SELECT 1 FROM issues AS i
  LEFT JOIN issue_workspaces AS w ON w.issue_id = i.id
  WHERE w.issue_id IS NULL OR (i.status = 'resolved') <> (i.resolved_at IS NOT NULL)
);
--> statement-breakpoint
DROP TABLE `_issue_recovery_state_check`;
--> statement-breakpoint
-- Retire the old repair of already-failed pending Issues. Current failure handling
-- writes open/failed atomically; only preparing/running work can be interrupted now.
UPDATE issues SET status = 'open', updated_at = unixepoch()
WHERE status = 'pending'
  AND (SELECT status FROM issue_workspaces WHERE issue_id = issues.id) = 'failed';
--> statement-breakpoint
CREATE INDEX `issue_workspaces_interrupted_idx` ON `issue_workspaces` (`status`, `issue_id`)
WHERE `status` IN ('preparing', 'running');
