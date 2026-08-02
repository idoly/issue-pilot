CREATE TABLE issue_cc_recipients (
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  subject varchar(255) NOT NULL REFERENCES subjects(subject),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX issue_cc_recipient_unique
  ON issue_cc_recipients (issue_id, subject);

CREATE INDEX issue_cc_recipient_subject_idx
  ON issue_cc_recipients (subject, created_at);
