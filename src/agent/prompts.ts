interface RepositoryContext {
  url: string;
  branch: string;
  path: string;
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
    "  scope: selected service repository root",
  ].join("\n");
}

export function continuationPrompt(issueKey: string, repositories: RepositoryContext[], latestUpdate?: string): string {
  return [
    `Continue handling engineering issue ${issueKey} in the existing persistent session.`,
    ...(latestUpdate ? ["", "Latest issue update:", latestUpdate] : []),
    "",
    "Current prepared repository scope:",
    ...repositories.map(repositoryLines),
    "",
    "Use the project descriptions and investigation findings already present in this session. Re-read repository files only where the latest message or refreshed scope requires it.",
    "The Issue Pilot extension enforces the active tools and repository paths. Do not attempt to bypass it or invoke arbitrary shell commands.",
    "Never push commits or branches to any remote, and do not expose credentials or raw logs. Return bounded database_read query results verbatim when they are relevant to the issue.",
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
}): string {
  return [
    input.latestUpdate ? `Continue handling engineering issue ${input.issueKey} using the latest issue update.` : `Handle engineering issue ${input.issueKey}: ${input.title}`,
    `Configured issue type: ${input.issueType}`,
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
    "Inspect the relevant code and establish the cause before editing. If the issue policy permits code mutation and the cause is a code-logic defect, implement the smallest correct fix in the prepared local issue branch and run appropriate tests.",
    "Use only tools activated by the Issue Pilot policy. Arbitrary shell execution and access outside the granted repositories are intentionally unavailable.",
    "Never push commits or branches to any remote, never create a merge request, and never run git push. Keep every code change local in the prepared issue branch for human review.",
    "Do not expose credentials or raw production logs. Return bounded database_read query results verbatim when they are relevant to the issue.",
  ].join("\n");
}
