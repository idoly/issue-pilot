import { CAPABILITY_KEYS, configuredCapabilities, ISSUE_TYPES_BY_ENVIRONMENT, normalizeIssueKey, type CapabilityName, type AgentConfiguration, type AgentCodemodeMode, type AgentThinkingLevel, type DeploymentConfig, type EnvironmentKind, type IssueType } from "../domain/contracts.ts";

export interface AgentSessionContext {
  issueKey: string;
  serviceKey: string;
  environmentKey: string;
  codemode: AgentCodemodeMode;
  model: { provider: string; modelId: string; thinkingLevel: AgentThinkingLevel };
  capabilities: ReturnType<typeof configuredCapabilities>;
  canModifyCode: boolean;
  canWriteOutputs: boolean;
}

export function sessionToolAllowlist(context: AgentSessionContext): string[] {
  return ["read", "bash", "edit", "write", "grep", "find", "ls", ...(context.codemode !== "off" ? ["codemode"] : []), ...(context.canWriteOutputs ? ["output"] : []), ...(context.capabilities.length ? ["service_query"] : [])];
}

export function createAgentSessionContext(input: {
  issueKey: string;
  issueType: IssueType;
  enabledCapabilities: readonly CapabilityName[];
  additionalDeploymentConfigs?: DeploymentConfig[];
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
    codemode: agent.codemode,
    capabilities: CAPABILITY_KEYS.filter((key) => input.enabledCapabilities.includes(key) && [input.deploymentConfig, ...(input.additionalDeploymentConfigs ?? [])].some((config) => configuredCapabilities(config).includes(key))),
    canModifyCode: writableIssue && input.repositoryAccess.length > 0 && input.repositoryAccess.every((access) => access === "write"),
    canWriteOutputs: input.environmentKind === "prod" && input.issueType === "data_processing",
  };
}
