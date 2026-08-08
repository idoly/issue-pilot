import { Value } from "typebox/value";

import type { CapabilityName } from "../domain/contracts.ts";
import type { IssuePolicy } from "../pi/policy.ts";
import { runPlaywright, type PlaywrightAction } from "./playwright.ts";
import { readNacosConfigurations, type NacosConnection } from "./nacos.ts";
import { readElasticsearch, readRabbitMq, readRedis } from "./external-data.ts";
import { localExecutor, type CommandExecutor } from "./local-exec.ts";
import { capabilityInputSchemas, capabilityResultText, capabilityTextResult, type CapabilityInputs } from "./contracts.ts";
import { queryMysql, validateReadOnlyQuery } from "./mysql.ts";
import { readSlsLogs } from "./sls.ts";

export async function readNacosCapability(pi: CommandExecutor, serviceKey: string, nacos: NacosConnection, signal?: AbortSignal) {
  const text = capabilityResultText({ configurations: await readNacosConfigurations(pi, nacos, signal) });
  return capabilityTextResult(text, { serviceKey });
}

async function readDatabase(policy: IssuePolicy, config: Record<string, unknown>, input: { statement: string }, signal?: AbortSignal) {
  const statement = validateReadOnlyQuery(input.statement);
  const scope = policy.service.db;
  if (!scope) throw new Error("db_scope_not_granted_for_service");
  if (typeof config.url !== "string" || typeof config.username !== "string" || typeof config.password !== "string") throw new Error("db_configuration_not_found");
  const connection = new URL(config.url);
  connection.username = config.username;
  connection.password = config.password;
  const output = await queryMysql({ connectionUrl: connection.href, statement }, signal);
  const text = capabilityResultText({ provider: "mysql", ...output });
  return capabilityTextResult(text, { serviceKey: policy.service.serviceKey, deploymentId: scope.deploymentId });
}

function capabilityConfig(config: Record<string, unknown>, capability: CapabilityName): Record<string, unknown> {
  const value = config[capability];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${capability}_configuration_not_found`);
  return value as Record<string, unknown>;
}

function capabilityInput<Key extends keyof CapabilityInputs>(capability: Key, input: unknown): CapabilityInputs[Key] {
  try {
    return Value.Parse(capabilityInputSchemas[capability], input ?? {}) as CapabilityInputs[Key];
  } catch {
    throw new Error(`invalid_${capability}_input`);
  }
}

export async function executeCapability(policy: IssuePolicy, deploymentConfig: Record<string, unknown>, capability: CapabilityName, input: unknown, signal?: AbortSignal) {
  if (!policy.service.capabilities.includes(capability)) throw new Error("capability_not_available");
  const config = capabilityConfig(deploymentConfig, capability);
  if (capability === "nacos") {
    capabilityInput("nacos", input);
    const grant = policy.service.nacos;
    if (!grant || typeof config.serverUrl !== "string" || typeof config.username !== "string") throw new Error("nacos_configuration_not_found");
    return readNacosCapability(localExecutor, policy.service.serviceKey, {
      serverUrl: grant.serverUrl,
      namespace: grant.namespace,
      group: grant.group,
      dataIds: grant.dataIds,
      username: config.username,
      password: typeof config.password === "string" ? config.password : "",
    }, signal);
  }
  if (capability === "db") return readDatabase(policy, config, capabilityInput("db", input), signal);
  if (capability === "sls") return readSlsLogs(localExecutor, policy, capabilityInput("sls", input), config, signal);
  if (capability === "redis") return readRedis(policy, config, capabilityInput("redis", input), signal);
  if (capability === "es") return readElasticsearch(policy, config, capabilityInput("es", input), signal);
  if (capability === "mq") return readRabbitMq(policy, config, capabilityInput("mq", input), signal);
  if (capability === "playwright") {
    const value = capabilityInput("playwright", input);
    const actions: PlaywrightAction[] = value.actions.map((action) => action.type === "login" ? {
      type: "login",
      usernameSelector: action.username_selector,
      passwordSelector: action.password_selector,
      submitSelector: action.submit_selector,
    } : action);
    return runPlaywright(localExecutor, policy, deploymentConfig, { actions, ...(value.screenshot === undefined ? {} : { screenshot: value.screenshot }) }, signal);
  }
  throw new Error("unsupported_capability");
}
