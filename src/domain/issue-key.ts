const ISSUE_KEY = /^ISSUE-(?:[0-9]{4,}|[0-9]{8}-[0-9]{3,4})$/i;

export function isIssueKey(value: string): boolean {
  return ISSUE_KEY.test(value);
}

export function normalizeIssueKey(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!isIssueKey(normalized)) throw new Error("invalid_issue_key");
  return normalized;
}
