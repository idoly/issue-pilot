-- Existing rows must already be valid before the enum is enforced.
CREATE TABLE __issue_type_guard (valid integer NOT NULL CHECK (valid = 1));
--> statement-breakpoint
INSERT INTO __issue_type_guard
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM issues WHERE type NOT IN ('smart_analysis', 'defect_fix', 'feature_development')
);
--> statement-breakpoint
DROP TABLE __issue_type_guard;
--> statement-breakpoint
-- The table default is still the retired 'request'; an insert that omits the type now fails loudly.
CREATE TRIGGER `issues_type_valid_insert` BEFORE INSERT ON `issues`
WHEN NEW.type NOT IN ('smart_analysis', 'defect_fix', 'feature_development')
BEGIN SELECT RAISE(ABORT, 'invalid_issue_type'); END;
--> statement-breakpoint
CREATE TRIGGER `issues_type_valid_update` BEFORE UPDATE OF `type` ON `issues`
WHEN NEW.type NOT IN ('smart_analysis', 'defect_fix', 'feature_development')
BEGIN SELECT RAISE(ABORT, 'invalid_issue_type'); END;
