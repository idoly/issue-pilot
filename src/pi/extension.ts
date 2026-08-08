import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { capabilityInputSchemas } from "../capabilities/contracts.ts";
import type { CapabilityName } from "../domain/contracts.ts";

export interface IssuePilotExtensionOptions {
  issueId: string;
  capabilities: CapabilityName[];
  brokerUrl: string;
  brokerToken: string;
}

interface BrokerResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details: unknown;
}

async function broker(options: IssuePilotExtensionOptions, capability: CapabilityName, input: unknown, signal?: AbortSignal): Promise<BrokerResult> {
  const response = await fetch(`${options.brokerUrl}/internal/agent-capabilities/${capability}`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.brokerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ issueId: options.issueId, input }),
    redirect: "error",
    ...(signal ? { signal } : {}),
  });
  const result = await response.json() as BrokerResult & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `capability_broker_${response.status}`);
  return result;
}

export function registerIssuePilotExtension(pi: ExtensionAPI, options: IssuePilotExtensionOptions): void {
  const enabled = new Set(options.capabilities);
  const register = (capability: CapabilityName, definition: Parameters<ExtensionAPI["registerTool"]>[0]) => {
    if (enabled.has(capability)) pi.registerTool(definition);
  };

  register("nacos", {
    name: "nacos",
    label: "Read Service Configuration",
    description: "Return the raw configuration for the deployment's authorized Nacos data IDs.",
    parameters: capabilityInputSchemas.nacos,
    execute: (_id, input, signal) => broker(options, "nacos", input, signal),
  });
  register("db", {
    name: "db",
    label: "Query Database",
    description: "Run one read-only SQL statement against the selected deployment database.",
    parameters: capabilityInputSchemas.db,
    execute: (_id, input, signal) => broker(options, "db", input, signal),
  });
  register("sls", {
    name: "sls",
    label: "Read SLS Logs",
    description: "Query the selected deployment's Simple Log Service.",
    parameters: capabilityInputSchemas.sls,
    execute: (_id, input, signal) => broker(options, "sls", input, signal),
  });
  register("redis", {
    name: "redis",
    label: "Read Redis",
    description: "Run one read-only Redis operation.",
    parameters: capabilityInputSchemas.redis,
    execute: (_id, input, signal) => broker(options, "redis", input, signal),
  });
  register("es", {
    name: "es",
    label: "Read Elasticsearch",
    description: "Run a search, count, or mapping request against the selected deployment.",
    parameters: capabilityInputSchemas.es,
    execute: (_id, input, signal) => broker(options, "es", input, signal),
  });
  register("mq", {
    name: "mq",
    label: "Read RabbitMQ",
    description: "Read RabbitMQ management metadata without consuming messages.",
    parameters: capabilityInputSchemas.mq,
    execute: (_id, input, signal) => broker(options, "mq", input, signal),
  });
  register("playwright", {
    name: "playwright",
    label: "Use Service Browser",
    description: "Run declarative browser actions against the selected deployment.",
    parameters: capabilityInputSchemas.playwright,
    execute: (_id, input, signal) => broker(options, "playwright", input, signal),
  });
}
