import { Value } from "typebox/value";

import type { CapabilityName } from "../domain/contracts.ts";
import type { IssuePolicy } from "../pi/policy.ts";
import { runBrowserActions, type BrowserAction } from "./playwright.ts";
import { readElasticsearch, readNacosConfigurations, readRabbitMq, readRedis, type NacosConnection } from "./external-data.ts";
import { localCommandExecutor } from "./local-exec.ts";
import { capabilityInputSchemas, capabilityResultText, capabilityTextResult, type CapabilityInputs } from "./contracts.ts";
import { queryDms } from "./dms.ts";
import { queryMysql, validateReadOnlyQuery } from "./mysql.ts";
import { readSlsLogs } from "./sls.ts";

export async function readNacosCapability(serviceKey: string, connection: NacosConnection, signal?: AbortSignal) {
  const text = capabilityResultText({ configurations: await readNacosConfigurations(connection, signal) });
  return capabilityTextResult(text, { serviceKey });
}

async function readDatabase(policy: IssuePolicy, dbConfig: Record<string, unknown>, input: { statement: string }, signal?: AbortSignal) {
  const statement = validateReadOnlyQuery(input.statement);
  const scope = policy.service.db;
  if (!scope) throw new Error("db_scope_not_granted_for_service");
  if (typeof dbConfig.url !== "string" || typeof dbConfig.username !== "string" || typeof dbConfig.password !== "string") throw new Error("db_configuration_not_found");
  const connectionUrl = new URL(dbConfig.url);
  connectionUrl.username = dbConfig.username;
  connectionUrl.password = dbConfig.password;
  const queryResult = await queryMysql({ connectionUrl: connectionUrl.href, statement }, signal);
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
    return Value.Parse(capabilityInputSchemas[capability], input ?? {}) as CapabilityInputs[Key];
  } catch {
    throw new Error(`invalid_${capability}_input`);
  }
}

export async function executeCapability(policy: IssuePolicy, deploymentConfig: Record<string, unknown>, capability: CapabilityName, input: unknown, signal?: AbortSignal) {
  if (!policy.service.capabilities.includes(capability)) throw new Error("capability_not_available");
  const capabilityConfig = requireCapabilityConfig(deploymentConfig, capability);
  if (capability === "nacos") {
    parseCapabilityInput("nacos", input);
    const grant = policy.service.nacos;
    if (!grant || typeof capabilityConfig.serverUrl !== "string" || typeof capabilityConfig.username !== "string") throw new Error("nacos_configuration_not_found");
    return readNacosCapability(policy.service.serviceKey, {
      serverUrl: grant.serverUrl,
      namespace: grant.namespace,
      group: grant.group,
      dataIds: grant.dataIds,
      username: capabilityConfig.username,
      password: typeof capabilityConfig.password === "string" ? capabilityConfig.password : "",
    }, signal);
  }
  if (capability === "db") return readDatabase(policy, capabilityConfig, parseCapabilityInput("db", input), signal);
  if (capability === "dms") return queryDms(localCommandExecutor, policy, parseCapabilityInput("dms", input), capabilityConfig, signal);
  if (capability === "sls") return readSlsLogs(localCommandExecutor, policy, parseCapabilityInput("sls", input), capabilityConfig, signal);
  if (capability === "redis") return readRedis(policy, capabilityConfig, parseCapabilityInput("redis", input), signal);
  if (capability === "es") return readElasticsearch(policy, capabilityConfig, parseCapabilityInput("es", input), signal);
  if (capability === "mq") return readRabbitMq(policy, capabilityConfig, parseCapabilityInput("mq", input), signal);
  if (capability === "playwright") {
    const browserInput = parseCapabilityInput("playwright", input);
    const actions: BrowserAction[] = browserInput.actions.map((action) => action.type === "login" ? {
      type: "login",
      usernameSelector: action.username_selector,
      passwordSelector: action.password_selector,
      submitSelector: action.submit_selector,
    } : action);
    return runBrowserActions(localCommandExecutor, policy, deploymentConfig, { actions, ...(browserInput.screenshot === undefined ? {} : { screenshot: browserInput.screenshot }) }, signal);
  }
  throw new Error("unsupported_capability");
}
