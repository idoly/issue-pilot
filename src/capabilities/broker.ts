import { Value } from "typebox/value";

import type { CapabilityName } from "../domain/contracts.ts";
import type { IssuePolicy } from "../pi/policy.ts";
import { capabilityResultText, capabilityTextResult } from "./contracts.ts";
import { queryDms } from "./dms.ts";
import { readElasticsearch } from "./elasticsearch.ts";
import { localCommandExecutor } from "./local-exec.ts";
import { readNacosConfigurations, type NacosConnection } from "./nacos.ts";
import { queryMysql, validateReadOnlyQuery } from "./mysql.ts";
import { runBrowserActions, type BrowserAction } from "./playwright.ts";
import { readRabbitMq } from "./rabbitmq.ts";
import { readRedis } from "./redis.ts";
import { capabilityDefinitions, type CapabilityInputs } from "./registry.ts";
import { readSlsLogs } from "./sls.ts";

export async function readNacosCapability(serviceKey: string, connection: NacosConnection, signal?: AbortSignal) {
  const text = capabilityResultText({ configurations: await readNacosConfigurations(connection, signal) });
  return capabilityTextResult(text, { serviceKey });
}

async function readDatabase(policy: IssuePolicy, config: Record<string, unknown>, input: CapabilityInputs["db"], signal?: AbortSignal) {
  const statement = validateReadOnlyQuery(input.statement);
  const scope = policy.service.db;
  if (!scope) throw new Error("db_scope_not_granted_for_service");
  if (typeof config.url !== "string" || typeof config.username !== "string" || typeof config.password !== "string") throw new Error("db_configuration_not_found");
  const url = new URL(config.url);
  url.username = config.username;
  url.password = config.password;
  const queryResult = await queryMysql({ connectionUrl: url.href, statement }, signal);
  const text = capabilityResultText({ provider: "mysql", ...queryResult });
  return capabilityTextResult(text, { serviceKey: policy.service.serviceKey, deploymentId: scope.deploymentId });
}

function requireCapabilityConfig(deploymentConfig: Record<string, unknown>, capability: CapabilityName): Record<string, unknown> {
  const capabilityConfig = deploymentConfig[capability];
  if (!capabilityConfig || typeof capabilityConfig !== "object" || Array.isArray(capabilityConfig)) throw new Error(`${capability}_configuration_not_found`);
  return capabilityConfig as Record<string, unknown>;
}

function parseCapabilityInput<Key extends keyof CapabilityInputs>(capability: Key, input: unknown): CapabilityInputs[Key] {
  try {
    return Value.Parse(capabilityDefinitions[capability].inputSchema, input ?? {}) as CapabilityInputs[Key];
  } catch {
    throw new Error(`invalid_${capability}_input`);
  }
}

type CapabilityHandler = (policy: IssuePolicy, config: Record<string, unknown>, input: unknown, signal?: AbortSignal) => Promise<unknown>;

const handlers: Record<CapabilityName, CapabilityHandler> = {
  playwright: async (policy, config, value, signal) => {
    const input = value as CapabilityInputs["playwright"];
    const actions: BrowserAction[] = input.actions.map((action) => action.type === "login" ? {
      type: "login", usernameSelector: action.username_selector, passwordSelector: action.password_selector, submitSelector: action.submit_selector,
    } : action);
    return runBrowserActions(localCommandExecutor, policy, { playwright: config }, { actions, ...(input.screenshot === undefined ? {} : { screenshot: input.screenshot }) }, signal);
  },
  nacos: async (policy, config, _input, signal) => {
    const scope = policy.service.nacos;
    if (!scope || typeof config.serverUrl !== "string" || typeof config.username !== "string") throw new Error("nacos_configuration_not_found");
    return readNacosCapability(policy.service.serviceKey, {
      serverUrl: scope.serverUrl, namespace: scope.namespace, group: scope.group, dataIds: scope.dataIds,
      username: config.username, password: typeof config.password === "string" ? config.password : "",
    }, signal);
  },
  db: (policy, config, input, signal) => readDatabase(policy, config, input as CapabilityInputs["db"], signal),
  redis: (policy, config, input, signal) => readRedis(policy, config, input as CapabilityInputs["redis"], signal),
  mq: (policy, config, input, signal) => readRabbitMq(policy, config, input as CapabilityInputs["mq"], signal),
  es: (policy, config, input, signal) => readElasticsearch(policy, config, input as CapabilityInputs["es"], signal),
  dms: (policy, config, input, signal) => queryDms(localCommandExecutor, policy, input as CapabilityInputs["dms"], config, signal),
  sls: (policy, config, input, signal) => readSlsLogs(localCommandExecutor, policy, input as CapabilityInputs["sls"], config, signal),
};

export async function executeCapability(policy: IssuePolicy, deploymentConfig: Record<string, unknown>, capability: CapabilityName, input: unknown, signal?: AbortSignal) {
  if (!policy.service.capabilities.includes(capability)) throw new Error("capability_not_available");
  const config = requireCapabilityConfig(deploymentConfig, capability);
  return handlers[capability](policy, config, parseCapabilityInput(capability, input), signal);
}
