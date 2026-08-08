import { Value } from "typebox/value";

import type { CapabilityName } from "../domain/contracts.ts";
import type { IssuePolicy } from "../pi/policy.ts";
import { readConfiguration, readDatabase } from "./queries.ts";
import { useBrowser, type BrowserAction } from "./browser.ts";
import { readElasticsearch, readRabbitMq, readRedis } from "./external.ts";
import { localExecutor } from "./local-exec.ts";
import { readSlsLogs } from "./sls.ts";
import { capabilityInputSchemas, type CapabilityInputs } from "./tool-schemas.ts";

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
    return readConfiguration(localExecutor, policy.service.serviceKey, {
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
    const actions: BrowserAction[] = value.actions.map((action) => action.type === "login" ? {
      type: "login",
      usernameSelector: action.username_selector,
      passwordSelector: action.password_selector,
      submitSelector: action.submit_selector,
    } : action);
    return useBrowser(localExecutor, policy, deploymentConfig, { actions, ...(value.screenshot === undefined ? {} : { screenshot: value.screenshot }) }, signal);
  }
  throw new Error("unsupported_capability");
}
