interface RepositoryContext {
  url: string;
  branch: string;
  path: string;
  readOnly: boolean;
}

interface ServiceContext {
  key: string;
  name: string;
  description?: string;
}

function repositoryLines(repository: RepositoryContext): string {
  return [
    `- ${repository.url}`,
    `  workspace: ${repository.path}`,
    `  branch: ${repository.branch}`,
    `  access: ${repository.readOnly ? "read-only baseline; do not modify files or create branches" : "writable local issue branch"}`,
    "  scope: selected service repository root",
  ].join("\n");
}

function shanghaiTime(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}+08:00`;
}

export function runtimeTimeContext(now = new Date()): string {
  return [
    "Current runtime time (authoritative for all relative time ranges):",
    `- UTC: ${now.toISOString()}`,
    `- Asia/Shanghai: ${shanghaiTime(now)}`,
    "Use this current runtime time for requests such as latest, now, today, or recent. Never reuse a timestamp from an earlier session message.",
  ].join("\n");
}

export function promptWithRuntimeTime(message: string, now = new Date()): string {
  return `${runtimeTimeContext(now)}\n\nUser request:\n${message}`;
}

export function continuationPrompt(issueKey: string, repositories: RepositoryContext[], latestUpdate?: string, now = new Date()): string {
  return [
    `Continue handling engineering issue ${issueKey} in the existing persistent session.`,
    "",
    runtimeTimeContext(now),
    ...(latestUpdate ? ["", "Latest issue update:", latestUpdate] : []),
    "",
    "Current prepared repository scope:",
    ...repositories.map(repositoryLines),
    "",
    "Use the project descriptions and investigation findings already present in this session. Re-read repository files only where the latest message or refreshed scope requires it.",
    "The Issue Pilot extension enforces the active tools and repository paths. Do not attempt to bypass it or invoke arbitrary shell commands.",
    "Never push commits or branches to any remote. Preserve complete tool results, including credentials and raw logs, when they are relevant to the issue. Present database connection fields as labeled lines and query rows as a compact table instead of JSON.",
    "When the work is complete or blocked, submit the structured outcome through complete_issue. A normal text response does not finish the run.",
  ].join("\n");
}

export function initialPrompt(input: {
  issueKey: string;
  title: string;
  description: string;
  issueType: string;
  repositories: RepositoryContext[];
  service: ServiceContext;
  latestUpdate?: string;
}, now = new Date()): string {
  return [
    input.latestUpdate ? `Continue handling engineering issue ${input.issueKey} using the latest issue update.` : `Handle engineering issue ${input.issueKey}: ${input.title}`,
    `Configured issue type: ${input.issueType}`,
    "",
    runtimeTimeContext(now),
    ...(input.issueType === "smart_analysis" ? [
      "First classify this issue as exactly one of: incident (defect fix), request (requirement), or question (analysis or technical consultation). Then follow the corresponding handling approach. In the final response, write the classification marker named ISSUE_TYPE followed by a colon and the selected lowercase value.",
    ] : []),
    "",
    "Issue description:",
    input.description || "No description was provided.",
    "",
    "Service context (required reading before investigating or changing a repository):",
    `- ${input.service.key} (${input.service.name})\n${input.service.description?.trim() || "  No service description was provided."}`,
    ...(input.latestUpdate ? ["", "Latest issue update:", input.latestUpdate, "", "Re-evaluate the issue using the latest metadata and repository context as needed."] : []),
    "",
    "Prepared repositories:",
    ...input.repositories.map(repositoryLines),
    "",
    "The prepared repositories are exactly those attached to the selected service. Focus code search, edits, builds, and tests on these repository roots and ignore retired workspace directories.",
    ...(input.repositories.every((repository) => repository.readOnly) ? ["This environment is investigation-only. Analyze causes and, when data changes are requested, produce SQL for human review; do not execute mutating SQL or modify repository files."] : []),
    "Inspect the relevant code and establish the cause before editing. If the issue policy permits code mutation and the cause is a code-logic defect, implement the smallest correct fix in the prepared local issue branch and run appropriate tests.",
    "Use only tools activated by the Issue Pilot policy. Arbitrary shell execution and access outside the granted repositories are intentionally unavailable.",
    "Never push commits or branches to any remote, never create a merge request, and never run git push. Keep every code change local in the prepared issue branch for human review.",
    "Preserve complete tool results, including credentials and raw production logs, when they are relevant to the issue. Present database connection fields as labeled lines and query rows as a compact table instead of JSON.",
    "Finish by calling complete_issue with the outcome, evidence, changes, verification, and risks. A normal text response does not complete the Issue Pilot run.",
  ].join("\n");
}
