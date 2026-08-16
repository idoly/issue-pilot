import path from "node:path";

import { capabilityScopesFromConfiguration, type CapabilityScopes } from "../capabilities/registry.ts";
import { AGENT_THINKING_LEVELS, CAPABILITY_KEYS, ISSUE_TYPES_BY_ENVIRONMENT, configuredCapabilities, isDmsDatabaseId, isDmsTenantId, normalizeIssueKey, type AgentThinkingLevel, type CapabilityName, type EnvironmentKind, type IssueType } from "../domain/contracts.ts";

export interface RepositoryGrant {
  codeAccess: "read" | "write";
  repositoryPath: string;
  baseCommit: string;
}

export interface ServiceGrant extends CapabilityScopes {
  serviceKey: string;
  environmentKey: string;
  environmentKind: EnvironmentKind;
  capabilities: CapabilityName[];
  repositories: RepositoryGrant[];
}

export interface ModelGrant {
  provider: string;
  modelId: string;
  thinkingLevel: AgentThinkingLevel;
}

export interface IssuePolicy {
  issueKey: string;
  issueType: IssueType;
  workspaceRoot: string;
  model: ModelGrant;
  service: ServiceGrant;
}

export function piToolAllowlist(policy: IssuePolicy): string[] {
  const localTools = policy.service.repositories.length > 0 && policy.service.repositories.every((repository) => repository.codeAccess === "write")
    ? ["read", "bash", "edit", "write", "grep", "find", "ls"]
    : ["read", "grep", "find", "ls"];
  return [...localTools, ...policy.service.capabilities];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function createIssuePolicy(input: {
  issueKey: string;
  issueType: IssueType;
  workspaceRoot: string;
  model: ModelGrant;
  service: ServiceGrant;
}): IssuePolicy {
  const capabilities = new Set(input.service.capabilities);
  const scopes: Record<CapabilityName, { deploymentId: string } | undefined> = {
    nacos: input.service.nacos,
    db: input.service.db,
    dms: input.service.dms,
    sls: input.service.sls,
    redis: input.service.redis,
    es: input.service.es,
    mq: input.service.mq,
  };
  for (const capability of CAPABILITY_KEYS) {
    const scope = scopes[capability];
    if (capabilities.has(capability) !== Boolean(scope) || (scope && !isNonEmptyString(scope.deploymentId))) throw new Error(`invalid_${capability}_service_scope`);
  }
  if (input.service.dms && (!isDmsDatabaseId(input.service.dms.dbId) || typeof input.service.dms.logic !== "boolean" || (input.service.dms.tid !== undefined && !isDmsTenantId(input.service.dms.tid)))) throw new Error("invalid_dms_service_scope");
  if (input.service.mq && !isNonEmptyString(input.service.mq.virtualHost)) throw new Error("invalid_mq_service_scope");

  const codeMutationAllowed = input.service.environmentKind === "dev" && ISSUE_TYPES_BY_ENVIRONMENT.dev.includes(input.issueType);
  const policy: IssuePolicy = {
    issueKey: normalizeIssueKey(input.issueKey),
    issueType: input.issueType,
    workspaceRoot: path.resolve(input.workspaceRoot),
    model: { ...input.model },
    service: {
      ...input.service,
      capabilities: CAPABILITY_KEYS.filter((capability) => capabilities.has(capability)),
      ...(input.service.nacos ? { nacos: { ...input.service.nacos, dataIds: [...new Set(input.service.nacos.dataIds)] } } : {}),
      ...(input.service.sls ? { sls: { ...input.service.sls, logstores: [...new Set(input.service.sls.logstores)].sort() } } : {}),
      ...(input.service.db ? { db: { ...input.service.db } } : {}),
      ...(input.service.dms ? { dms: { ...input.service.dms } } : {}),
      ...(input.service.redis ? { redis: { ...input.service.redis } } : {}),
      ...(input.service.es ? { es: { ...input.service.es } } : {}),
      ...(input.service.mq ? { mq: { ...input.service.mq } } : {}),
      repositories: input.service.repositories.map((repository) => Object.freeze({
        ...repository,
        codeAccess: codeMutationAllowed && repository.codeAccess === "write" ? "write" : "read",
        repositoryPath: path.resolve(repository.repositoryPath),
      })),
    },
  };
  Object.freeze(policy.model);
  Object.freeze(policy.service.capabilities);
  Object.freeze(policy.service.repositories);
  if (policy.service.nacos) Object.freeze(policy.service.nacos.dataIds);
  if (policy.service.sls) Object.freeze(policy.service.sls.logstores);
  for (const scope of [policy.service.nacos, policy.service.db, policy.service.dms, policy.service.sls, policy.service.redis, policy.service.es, policy.service.mq]) {
    if (scope) Object.freeze(scope);
  }
  Object.freeze(policy.service);
  return Object.freeze(policy);
}

function configObject(config: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const section = config[key];
  return section && typeof section === "object" && !Array.isArray(section) ? section as Record<string, unknown> : undefined;
}

function parseModelGrant(config: Record<string, unknown>): ModelGrant {
  const agentConfig = configObject(config, "agent");
  const provider = agentConfig && isNonEmptyString(agentConfig.provider) ? agentConfig.provider : undefined;
  const modelId = agentConfig && isNonEmptyString(agentConfig.model) ? agentConfig.model : undefined;
  const thinkingLevel = agentConfig && AGENT_THINKING_LEVELS.includes(agentConfig.thinkingLevel as AgentThinkingLevel)
    ? agentConfig.thinkingLevel as AgentThinkingLevel
    : undefined;
  if (!provider || !modelId || !thinkingLevel) throw new Error("issue_pilot_model_not_configured");
  return { provider, modelId, thinkingLevel };
}

export function createDeploymentPolicy(input: {
  issueKey: string;
  issueType: IssueType;
  workspaceRoot: string;
  deploymentId: string;
  deploymentConfig: Record<string, unknown>;
  serviceKey: string;
  environmentKey: string;
  environmentKind: ServiceGrant["environmentKind"];
  repositories: RepositoryGrant[];
}): IssuePolicy {
  return createIssuePolicy({
    issueKey: input.issueKey,
    issueType: input.issueType,
    workspaceRoot: input.workspaceRoot,
    model: parseModelGrant(input.deploymentConfig),
    service: {
      serviceKey: input.serviceKey,
      environmentKey: input.environmentKey,
      environmentKind: input.environmentKind,
      capabilities: configuredCapabilities(input.deploymentConfig),
      ...capabilityScopesFromConfiguration(input.deploymentConfig, input.deploymentId),
      repositories: input.repositories,
    },
  });
}
