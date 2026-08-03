export const legacyIssueKeyPattern = /^ISSUE-[0-9]{4,}$/i;
export const datedIssueKeyPattern = /^ISSUE-[0-9]{8}-[0-9]{3,4}$/i;

export function isIssueKey(value: string): boolean {
  return legacyIssueKeyPattern.test(value) || datedIssueKeyPattern.test(value);
}

export function formatIssueDate(date: Date, timeZone = "Asia/Shanghai"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}${values.get("month")}${values.get("day")}`;
}

export function nextDatedIssueKey(existingKeys: Iterable<string>, date: Date, timeZone = "Asia/Shanghai"): string {
  const issueDate = formatIssueDate(date, timeZone);
  const pattern = new RegExp(`^ISSUE-${issueDate}-([0-9]{3,4})$`, "i");
  let maximum = 0;
  for (const key of existingKeys) {
    const match = pattern.exec(key);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  const next = maximum + 1;
  if (next > 999) throw new Error("daily issue key sequence exhausted");
  return `ISSUE-${issueDate}-${String(next).padStart(3, "0")}`;
}
