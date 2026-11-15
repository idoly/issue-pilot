-- Existing Issues read as version 0; no backfill or detail scan is needed.
ALTER TABLE issues ADD COLUMN detail_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Publish invalidation in the same transaction as the detail write, regardless of its caller.
-- Summary fields, including CC subjects and Workspace state, are already part of the HTTP digest.
CREATE TRIGGER issues_description_revision AFTER UPDATE OF description ON issues
WHEN OLD.description IS NOT NEW.description
BEGIN
  UPDATE issues SET detail_revision = detail_revision + 1 WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER issue_comment_revision AFTER INSERT ON issue_comments
BEGIN
  UPDATE issues SET detail_revision = detail_revision + 1 WHERE id = NEW.issue_id;
END;
--> statement-breakpoint
CREATE TRIGGER issue_attachment_added_revision AFTER INSERT ON issue_attachments
BEGIN
  UPDATE issues SET detail_revision = detail_revision + 1 WHERE id = NEW.issue_id;
END;
--> statement-breakpoint
CREATE TRIGGER issue_attachment_removed_revision AFTER DELETE ON issue_attachments
BEGIN
  UPDATE issues SET detail_revision = detail_revision + 1 WHERE id = OLD.issue_id;
END;
--> statement-breakpoint
CREATE TRIGGER issue_relation_added_revision AFTER INSERT ON issue_relations
BEGIN
  UPDATE issues SET detail_revision = detail_revision + 1 WHERE id = NEW.issue_id;
END;
--> statement-breakpoint
CREATE TRIGGER issue_relation_removed_revision AFTER DELETE ON issue_relations
BEGIN
  UPDATE issues SET detail_revision = detail_revision + 1 WHERE id = OLD.issue_id;
END;
--> statement-breakpoint
CREATE TRIGGER issue_service_added_revision AFTER INSERT ON issue_service_scopes
BEGIN
  UPDATE issues SET detail_revision = detail_revision + 1 WHERE id = NEW.issue_id;
END;
--> statement-breakpoint
CREATE TRIGGER issue_service_removed_revision AFTER DELETE ON issue_service_scopes
BEGIN
  UPDATE issues SET detail_revision = detail_revision + 1 WHERE id = OLD.issue_id;
END;
--> statement-breakpoint
CREATE TRIGGER issue_repository_added_revision AFTER INSERT ON issue_repositories
BEGIN
  UPDATE issues SET detail_revision = detail_revision + 1 WHERE id = NEW.issue_id;
END;
--> statement-breakpoint
CREATE TRIGGER issue_repository_removed_revision AFTER DELETE ON issue_repositories
BEGIN
  UPDATE issues SET detail_revision = detail_revision + 1 WHERE id = OLD.issue_id;
END;
--> statement-breakpoint
CREATE TRIGGER issue_repository_binding_revision AFTER UPDATE OF url, base_branch, working_branch, local_path, workspace_name ON issue_repositories
WHEN OLD.url IS NOT NEW.url OR OLD.base_branch IS NOT NEW.base_branch OR OLD.working_branch IS NOT NEW.working_branch
  OR OLD.local_path IS NOT NEW.local_path OR OLD.workspace_name IS NOT NEW.workspace_name
BEGIN
  UPDATE issues SET detail_revision = detail_revision + 1 WHERE id = NEW.issue_id;
END;
--> statement-breakpoint
CREATE TRIGGER issue_scope_transition_revision AFTER INSERT ON issue_scope_transitions
BEGIN
  UPDATE issues SET detail_revision = detail_revision + 1 WHERE id = NEW.issue_id;
END;
--> statement-breakpoint
CREATE TRIGGER issue_session_bound_revision AFTER INSERT ON issue_pilot_sessions
BEGIN
  UPDATE issues SET detail_revision = detail_revision + 1 WHERE id = NEW.issue_id;
END;
--> statement-breakpoint
CREATE TRIGGER issue_session_rebound_revision AFTER UPDATE OF session_file ON issue_pilot_sessions
WHEN OLD.session_file IS NOT NEW.session_file
BEGIN
  UPDATE issues SET detail_revision = detail_revision + 1 WHERE id = NEW.issue_id;
END;
