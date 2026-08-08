import path from "node:path";

import { AGENT_THINKING_LEVELS, CAPABILITY_KEYS, ISSUE_TYPES_BY_ENVIRONMENT, configuredCapabilities, normalizeIssueKey, type AgentThinkingLevel, type CapabilityName, type EnvironmentKind, type IssueType } from "../domain/contracts.ts";

export interface RepositoryGrant {
  codeAccess: "read" | "write";
  repositoryPath: string;
  baseCommit: string;
}

export interface ServiceGrant {
  serviceKey: string;
  environmentKey: string;
  environmentKind: EnvironmentKind;
  capabilities: CapabilityName[];
  nacos?: { deploymentId: string; serverUrl: string; namespace: string; group: string; dataIds: string[] };
  db?: { deploymentId: string };
  sls?: { deploymentId: string; region: string; project: string; logstores: string[] };
  playwright?: { deploymentId: string; baseUrl: string };
  redis?: { deploymentId: string };
  es?: { deploymentId: string };
  mq?: { deploymentId: string; virtualHost: string };
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
    sls: input.service.sls,
    playwright: input.service.playwright,
    redis: input.service.redis,
    es: input.service.es,
    mq: input.service.mq,
  };
  for (const capability of CAPABILITY_KEYS) {
    const label = capability === "playwright" ? "browser" : capability;
    const scope = scopes[capability];
    if (capabilities.has(capability) !== Boolean(scope) || (scope && !isNonEmptyString(scope.deploymentId))) throw new Error(`invalid_${label}_service_scope`);
  }
  if (input.service.mq && !isNonEmptyString(input.service.mq.virtualHost)) throw new Error("invalid_mq_service_scope");
  if (input.service.playwright) {
    let parsedUrl: URL;
    try { parsedUrl = new URL(input.service.playwright.baseUrl); } catch { throw new Error("invalid_browser_service_scope"); }
    if (!isNonEmptyString(input.service.playwright.deploymentId) || !["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new Error("invalid_browser_service_scope");
  }

  const codeMutationAllowed = input.service.environmentKind === "dev" && ISSUE_TYPES_BY_ENVIRONMENT.dev.includes(input.issueType);
  return {
    issueKey: normalizeIssueKey(input.issueKey),
    issueType: input.issueType,
    workspaceRoot: path.resolve(input.workspaceRoot),
    model: input.model,
    service: {
      ...input.service,
      capabilities: CAPABILITY_KEYS.filter((capability) => capabilities.has(capability)),
      ...(input.service.sls ? { sls: { ...input.service.sls, logstores: [...new Set(input.service.sls.logstores)].sort() } } : {}),
      repositories: input.service.repositories.map((repository) => ({
        ...repository,
        codeAccess: codeMutationAllowed && repository.codeAccess === "write" ? "write" : "read",
        repositoryPath: path.resolve(repository.repositoryPath),
      })),
    },
  };
}

function configObject(config: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = config[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(isNonEmptyString) ? value : undefined;
}

function parseModelGrant(config: Record<string, unknown>): ModelGrant {
  const agent = configObject(config, "agent");
  const provider = agent && isNonEmptyString(agent.provider) ? agent.provider : undefined;
  const modelId = agent && isNonEmptyString(agent.model) ? agent.model : undefined;
  const thinkingLevel = agent && AGENT_THINKING_LEVELS.includes(agent.thinkingLevel as AgentThinkingLevel)
    ? agent.thinkingLevel as AgentThinkingLevel
    : undefined;
  if (!provider || !modelId || !thinkingLevel) throw new Error("issue_pilot_model_not_configured");
  return { provider, modelId, thinkingLevel };
}

function parseCapabilityScopes(config: Record<string, unknown>, deploymentId: string): Partial<ServiceGrant> {
  const scopes: Partial<ServiceGrant> = {};
  const nacos = configObject(config, "nacos");
  const dataIds = readStringArray(nacos?.dataIds);
  if (nacos && isNonEmptyString(nacos.serverUrl) && typeof nacos.namespace === "string" && isNonEmptyString(nacos.group) && dataIds?.length) {
    scopes.nacos = { deploymentId, serverUrl: nacos.serverUrl, namespace: nacos.namespace, group: nacos.group, dataIds: [...new Set(dataIds)] };
  }

  if (configObject(config, "db")) scopes.db = { deploymentId };
  if (configObject(config, "redis")) scopes.redis = { deploymentId };
  if (configObject(config, "es")) scopes.es = { deploymentId };

  const sls = configObject(config, "sls");
  const logstores = readStringArray(sls?.logstores);
  if (sls && isNonEmptyString(sls.region) && isNonEmptyString(sls.project) && logstores) scopes.sls = { deploymentId, region: sls.region, project: sls.project, logstores };

  const playwright = configObject(config, "playwright");
  if (playwright && isNonEmptyString(playwright.baseUrl)) scopes.playwright = { deploymentId, baseUrl: playwright.baseUrl };

  const mq = configObject(config, "mq");
  if (mq && isNonEmptyString(mq.virtualHost)) scopes.mq = { deploymentId, virtualHost: mq.virtualHost };
  return scopes;
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
      ...parseCapabilityScopes(input.deploymentConfig, input.deploymentId),
      repositories: input.repositories,
    },
  });
}
