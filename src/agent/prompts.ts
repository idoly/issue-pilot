import type { IssuePolicy } from "../pi/policy.ts";

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

export function agentSystemPrompt(policy: IssuePolicy): string {
  const writable = policy.service.repositories.filter((repository) => repository.codeAccess === "write").length;
  return [
    "Issue Pilot execution policy:",
    `- Work only on issue ${policy.issueKey} in the current workspace.`,
    `- The selected service is ${policy.service.serviceKey} in ${policy.service.environmentKey}.`,
    `- ${writable ? `${writable} repository workspace(s) may be edited` : "All repository workspaces are read-only"}.`,
    "- Treat tool availability and tool validation as hard authorization boundaries.",
    "- Never disclose connection credentials or infer access beyond the configured deployment scope.",
    "- Capability results are complete bounded evidence or explicit failures; do not claim omitted evidence.",
  ].join("\n");
}

function workspaceContext(repositories: RepositoryContext[], attachmentPath: string): string {
  const readOnly = repositories.every((repository) => repository.readOnly);
  return [
    `Attachments, if present, are in ${attachmentPath}.`,
    ...(readOnly
      ? ["Repositories are shared read-only snapshots of the latest configured deployment branches. Do not attempt to modify them."]
      : [
        "Project checks: node-project <path> <install|test|build|typecheck>; maven-project <path> <test|verify|package>. Both wrappers use the configured host runtimes.",
        "For defect_fix and feature_development, make only the minimum changes required by the issue. Avoid unrelated refactors, formatting churn, dependency changes, and speculative improvements.",
        "Leave working tree changes uncommitted for user review in code-server unless the user explicitly asks you to commit or push them.",
      ]),
  ].join("\n");
}

export function continuationPrompt(issueKey: string, repositories: RepositoryContext[], attachmentPath: string, latestUpdate?: string, now = new Date()): string {
  return [
    `Continue ${issueKey}.`,
    runtimeTimeContext(now),
    ...(latestUpdate ? ["Latest update:", latestUpdate] : []),
    "Repositories:",
    ...repositories.map(repositoryLine),
    workspaceContext(repositories, attachmentPath),
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
  attachmentPath: string;
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
    workspaceContext(input.repositories, input.attachmentPath),
    input.repositories.every((repository) => repository.readOnly)
      ? "Investigate, verify the available evidence, and provide a clear final answer."
      : "Investigate, make appropriate local changes, verify them, and provide a clear final answer.",
  ].join("\n\n");
}
