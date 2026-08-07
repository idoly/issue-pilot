import path from "node:path";

import { ISSUE_TYPES_BY_ENVIRONMENT, type EnvironmentKind, type IssueType } from "../domain/contracts.ts";
import { CAPABILITY_KEYS, configuredCapabilities, type CapabilityName } from "../domain/contracts.ts";
import { normalizeIssueKey } from "../domain/issue-key.ts";

export type ServiceCapabilityName = CapabilityName;
export interface RepositoryGrant {
  codeAccess: "read" | "write";
  repositoryPath: string;
  baseCommit: string;
}

export interface ServiceGrant {
  serviceKey: string;
  environmentKey: string;
  environmentKind: EnvironmentKind;
  capabilities: ServiceCapabilityName[];
  nacos?: { deploymentId: string; serverUrl: string; namespace: string; group: string };
  db?: { deploymentId: string };
  sls?: { deploymentId: string; region: string; project: string; logstores: string[] };
  browser?: { deploymentId: string; baseUrl: string };
  redis?: { deploymentId: string };
  es?: { deploymentId: string };
  mq?: { deploymentId: string; virtualHost: string };
  repositories: RepositoryGrant[];
}

export interface GrantedRepository extends RepositoryGrant {
  serviceKey: string;
  environmentKey: string;
  environmentKind: EnvironmentKind;
}

export interface ModelGrant {
  provider: string;
  modelId: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface IssuePolicy {
  issueKey: string;
  issueType: IssueType;
  workspaceRoot: string;
  model: ModelGrant;
  service: ServiceGrant;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function createIssuePolicy(input: {
  issueKey: string;
  issueType: IssueType;
  workspaceRoot: string;
  model?: ModelGrant;
  service: ServiceGrant;
}): IssuePolicy {
  const capabilities = new Set(input.service.capabilities);
  const scopes: Record<CapabilityName, { deploymentId: string } | undefined> = {
    nacos: input.service.nacos,
    db: input.service.db,
    sls: input.service.sls,
    playwright: input.service.browser,
    redis: input.service.redis,
    es: input.service.es,
    mq: input.service.mq,
  };
  for (const capability of CAPABILITY_KEYS) {
    const label = capability === "playwright" ? "browser" : capability;
    const scope = scopes[capability];
    if (capabilities.has(capability) !== Boolean(scope) || (scope && !isString(scope.deploymentId))) throw new Error(`invalid_${label}_service_scope`);
  }
  if (input.service.mq && !isString(input.service.mq.virtualHost)) throw new Error("invalid_mq_service_scope");
  if (input.service.browser) {
    let parsedUrl: URL;
    try { parsedUrl = new URL(input.service.browser.baseUrl); } catch { throw new Error("invalid_browser_service_scope"); }
    if (!isString(input.service.browser.deploymentId) || !["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new Error("invalid_browser_service_scope");
  }

  const codeMutationAllowed = input.service.environmentKind === "dev" && ISSUE_TYPES_BY_ENVIRONMENT.dev.includes(input.issueType);
  return {
    issueKey: normalizeIssueKey(input.issueKey),
    issueType: input.issueType,
    workspaceRoot: path.resolve(input.workspaceRoot),
    model: input.model ?? { provider: "managed", modelId: "default", thinkingLevel: "medium" },
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
  const object = (key: string): Record<string, unknown> | undefined => {
    const value = input.deploymentConfig[key];
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  };
  const agent = object("agent") ?? {};
  const provider = isString(agent.provider) ? agent.provider : process.env.ISSUE_PILOT_PROVIDER ?? process.env.PI_PROVIDER;
  const modelId = isString(agent.model) ? agent.model : process.env.ISSUE_PILOT_MODEL ?? process.env.PI_MODEL;
  if (!provider || !modelId) throw new Error("issue_pilot_model_not_configured");
  const levels = new Set<ModelGrant["thinkingLevel"]>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const requestedLevel = isString(agent.thinkingLevel) ? agent.thinkingLevel : process.env.ISSUE_PILOT_REASONING ?? process.env.PI_REASONING_LEVEL;
  const thinkingLevel = levels.has(requestedLevel as ModelGrant["thinkingLevel"]) ? requestedLevel as ModelGrant["thinkingLevel"] : "medium";

  const nacos = object("nacos");
  const sls = object("sls");
  const mq = object("mq");
  const playwright = object("playwright");
  const capabilities = configuredCapabilities(input.deploymentConfig);
  return createIssuePolicy({
    issueKey: input.issueKey,
    issueType: input.issueType,
    workspaceRoot: input.workspaceRoot,
    model: { provider, modelId, thinkingLevel },
    service: {
      serviceKey: input.serviceKey,
      environmentKey: input.environmentKey,
      environmentKind: input.environmentKind,
      capabilities,
      ...(nacos && isString(nacos.serverUrl) && typeof nacos.namespace === "string" && isString(nacos.group) ? { nacos: { deploymentId: input.deploymentId, serverUrl: nacos.serverUrl, namespace: nacos.namespace, group: nacos.group } } : {}),
      ...(object("db") ? { db: { deploymentId: input.deploymentId } } : {}),
      ...(sls && isString(sls.region) && isString(sls.project) && Array.isArray(sls.logstores) && sls.logstores.every(isString) ? { sls: { deploymentId: input.deploymentId, region: sls.region, project: sls.project, logstores: sls.logstores } } : {}),
      ...(playwright && isString(playwright.baseUrl) ? { browser: { deploymentId: input.deploymentId, baseUrl: playwright.baseUrl } } : {}),
      ...(object("redis") ? { redis: { deploymentId: input.deploymentId } } : {}),
      ...(object("es") ? { es: { deploymentId: input.deploymentId } } : {}),
      ...(mq && isString(mq.virtualHost) ? { mq: { deploymentId: input.deploymentId, virtualHost: mq.virtualHost } } : {}),
      repositories: input.repositories,
    },
  });
}

export function assertSlsGranted(policy: IssuePolicy, project: string, logstore: string): void {
  if (!policy.service.capabilities.includes("sls") || policy.service.sls?.project !== project || !policy.service.sls.logstores.includes(logstore)) throw new Error("sls_scope_not_granted_for_service");
}

export function grantedRepositories(policy: IssuePolicy, capability?: ServiceCapabilityName): GrantedRepository[] {
  if (capability && !policy.service.capabilities.includes(capability)) throw new Error("capability_not_granted_for_service");
  return policy.service.repositories.map((repository) => ({
    ...repository,
    serviceKey: policy.service.serviceKey,
    environmentKey: policy.service.environmentKey,
    environmentKind: policy.service.environmentKind,
  }));
}
