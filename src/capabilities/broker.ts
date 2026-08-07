import type { CapabilityName } from "../domain/contracts.ts";
import { grantedRepositories, type IssuePolicy } from "../pi/policy.ts";
import { readConfiguration, readDatabase } from "./queries.ts";
import { useBrowser, type BrowserAction } from "./browser.ts";
import { readElasticsearch, readRabbitMq, readRedis } from "./external.ts";
import { localExecutor } from "./local-exec.ts";
import { readSlsLogs } from "./sls.ts";

function capabilityConfig(config: Record<string, unknown>, capability: CapabilityName): Record<string, unknown> {
  const value = config[capability];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${capability}_configuration_not_found`);
  return value as Record<string, unknown>;
}

export async function executeCapability(policy: IssuePolicy, deploymentConfig: Record<string, unknown>, capability: CapabilityName, input: unknown, signal?: AbortSignal) {
  if (!policy.service.capabilities.includes(capability)) throw new Error("capability_not_available");
  const config = capabilityConfig(deploymentConfig, capability);
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  if (capability === "nacos") {
    const grant = policy.service.nacos;
    if (!grant || typeof config.serverUrl !== "string" || typeof config.username !== "string") throw new Error("nacos_configuration_not_found");
    return readConfiguration(localExecutor, grantedRepositories(policy, "nacos"), deploymentConfig, signal, {
      serverUrl: grant.serverUrl,
      namespace: grant.namespace,
      group: grant.group,
      username: config.username,
      password: typeof config.password === "string" ? config.password : "",
    });
  }
  if (capability === "db") return readDatabase(policy, config, value as { statement: string }, signal);
  if (capability === "sls") return readSlsLogs(localExecutor, policy, value as Parameters<typeof readSlsLogs>[2], config, signal);
  if (capability === "redis") return readRedis(policy, config, value as Parameters<typeof readRedis>[2], signal);
  if (capability === "es") return readElasticsearch(policy, config, value as Parameters<typeof readElasticsearch>[2], signal);
  if (capability === "mq") return readRabbitMq(policy, config, value as Parameters<typeof readRabbitMq>[2], signal);
  if (capability === "playwright") {
    const actions = Array.isArray(value.actions) ? value.actions.map((action) => {
      const item = action as Record<string, unknown>;
      return item.type === "login" ? {
        type: "login" as const,
        usernameSelector: String(item.username_selector),
        passwordSelector: String(item.password_selector),
        submitSelector: String(item.submit_selector),
      } : item as BrowserAction;
    }) : [];
    return useBrowser(localExecutor, policy, deploymentConfig, { actions, ...(typeof value.screenshot === "boolean" ? { screenshot: value.screenshot } : {}) }, signal);
  }
  throw new Error("unsupported_capability");
}
