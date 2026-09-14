import { configuredCapabilities, ISSUE_TYPES_BY_ENVIRONMENT, normalizeIssueKey, type AgentConfiguration, type AgentThinkingLevel, type DeploymentConfig, type EnvironmentKind, type IssueType } from "../domain/contracts.ts";

export interface AgentSessionContext {
  issueKey: string;
  serviceKey: string;
  environmentKey: string;
  model: { provider: string; modelId: string; thinkingLevel: AgentThinkingLevel };
  capabilities: ReturnType<typeof configuredCapabilities>;
  canModifyCode: boolean;
}

export function sessionToolAllowlist(context: AgentSessionContext): string[] {
  const localTools = context.canModifyCode
    ? ["read", "bash", "edit", "write", "grep", "find", "ls"]
    : ["read", "grep", "find", "ls"];
  return [...localTools, ...context.capabilities];
}

export function createAgentSessionContext(input: {
  issueKey: string;
  issueType: IssueType;
  deploymentConfig: DeploymentConfig;
  agentConfiguration: AgentConfiguration;
  serviceKey: string;
  environmentKey: string;
  environmentKind: EnvironmentKind;
  repositoryAccess: Array<"read" | "write">;
}): AgentSessionContext {
  const agent = input.agentConfiguration;
  const writableIssue = input.environmentKind === "dev" && ISSUE_TYPES_BY_ENVIRONMENT.dev.includes(input.issueType);
  return {
    issueKey: normalizeIssueKey(input.issueKey),
    serviceKey: input.serviceKey,
    environmentKey: input.environmentKey,
    model: { provider: agent.provider, modelId: agent.model, thinkingLevel: agent.thinkingLevel },
    capabilities: configuredCapabilities(input.deploymentConfig),
    canModifyCode: writableIssue && input.repositoryAccess.length > 0 && input.repositoryAccess.every((access) => access === "write"),
  };
}
