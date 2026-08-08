interface RepositoryContext {
  branch: string;
  path: string;
  readOnly: boolean;
}

interface ServiceContext {
  key: string;
  name: string;
  description?: string;
}

function repositoryLine(repository: RepositoryContext): string {
  return `- ${repository.path} (${repository.branch}, ${repository.readOnly ? "read-only" : "writable"})`;
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
    "Current time:",
    `- UTC: ${now.toISOString()}`,
    `- Asia/Shanghai: ${shanghaiTime(now)}`,
  ].join("\n");
}

export function promptWithRuntimeTime(message: string, now = new Date()): string {
  return `${runtimeTimeContext(now)}\n\nUser request:\n${message}`;
}

const workspaceContext = [
  "Attachments, if present, are in .issue-pilot/attachments/.",
  "Containerized checks: node-project <path> <install|test|build|typecheck>; maven-project <path> <test|verify|package>.",
  "For defect_fix and feature_development, make only the minimum changes required by the issue. Avoid unrelated refactors, formatting churn, dependency changes, and speculative improvements.",
  "Leave working tree changes uncommitted for user review in code-server unless the user explicitly asks you to commit or push them.",
].join("\n");

export function continuationPrompt(issueKey: string, repositories: RepositoryContext[], latestUpdate?: string, now = new Date()): string {
  return [
    `Continue ${issueKey}.`,
    runtimeTimeContext(now),
    ...(latestUpdate ? ["Latest update:", latestUpdate] : []),
    "Repositories:",
    ...repositories.map(repositoryLine),
    workspaceContext,
    "Use the existing Pi session context and provide a clear final answer when this turn is complete.",
  ].join("\n\n");
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
    `Handle ${input.issueKey}: ${input.title}`,
    `Type: ${input.issueType}`,
    runtimeTimeContext(now),
    `Description:\n${input.description || "No description provided."}`,
    `Service: ${input.service.key} (${input.service.name})\n${input.service.description?.trim() || ""}`.trim(),
    ...(input.latestUpdate ? [`Latest update:\n${input.latestUpdate}`] : []),
    `Repositories:\n${input.repositories.map(repositoryLine).join("\n")}`,
    workspaceContext,
    "Investigate, make appropriate local changes, verify them, and provide a clear final answer.",
  ].join("\n\n");
}
