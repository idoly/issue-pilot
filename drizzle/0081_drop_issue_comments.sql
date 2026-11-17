-- Human Issue comments are retired from HTTP, Issue detail and inbound MCP; deleting their history was authorized.
-- Only the comment trigger from 0078 is dropped; the other detail_revision triggers stay.
DROP TRIGGER `issue_comment_revision`;
--> statement-breakpoint
DROP INDEX `issue_comments_issue_idx`;
--> statement-breakpoint
DROP TABLE `issue_comments`;
