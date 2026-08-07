import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
    description: "Return the effective service configuration from repository files and Nacos.",
    parameters: Type.Object({}),
    execute: (_id, input, signal) => broker(options, "nacos", input, signal),
  });
  register("db", {
    name: "db",
    label: "Query Database",
    description: "Run one read-only SQL statement against the selected deployment database.",
    parameters: Type.Object({ statement: Type.String({ maxLength: 20_000 }) }),
    execute: (_id, input, signal) => broker(options, "db", input, signal),
  });
  register("sls", {
    name: "sls",
    label: "Read SLS Logs",
    description: "Query the selected deployment's Simple Log Service.",
    parameters: Type.Object({
      project: Type.String({ maxLength: 63 }),
      logstore: Type.String({ maxLength: 63 }),
      from: Type.Optional(Type.Integer({ minimum: 0 })),
      to: Type.Optional(Type.Integer({ minimum: 1 })),
      query: Type.Optional(Type.String({ maxLength: 4096 })),
      trace_id: Type.Optional(Type.String({ maxLength: 36 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute: (_id, input, signal) => broker(options, "sls", input, signal),
  });
  register("redis", {
    name: "redis",
    label: "Read Redis",
    description: "Run one read-only Redis operation.",
    parameters: Type.Object({
      action: StringEnum(["get", "mget", "hget", "hgetall", "type", "ttl", "scan"] as const),
      key: Type.Optional(Type.String({ maxLength: 1024 })),
      keys: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }))),
      field: Type.Optional(Type.String({ maxLength: 1024 })),
      pattern: Type.Optional(Type.String({ maxLength: 1024 })),
      cursor: Type.Optional(Type.String({ maxLength: 30 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute: (_id, input, signal) => broker(options, "redis", input, signal),
  });
  register("es", {
    name: "es",
    label: "Read Elasticsearch",
    description: "Run a search, count, or mapping request against the selected deployment.",
    parameters: Type.Object({
      action: StringEnum(["search", "count", "mapping"] as const),
      query: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute: (_id, input, signal) => broker(options, "es", input, signal),
  });
  register("mq", {
    name: "mq",
    label: "Read RabbitMQ",
    description: "Read RabbitMQ management metadata without consuming messages.",
    parameters: Type.Object({
      action: StringEnum(["overview", "queues", "queue", "bindings"] as const),
      queue: Type.Optional(Type.String({ maxLength: 255 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute: (_id, input, signal) => broker(options, "mq", input, signal),
  });
  register("playwright", {
    name: "playwright",
    label: "Use Service Browser",
    description: "Run declarative browser actions against the selected deployment.",
    parameters: Type.Object({
      actions: Type.Array(Type.Union([
        Type.Object({ type: Type.Literal("goto"), path: Type.String({ maxLength: 2048 }) }),
        Type.Object({ type: Type.Literal("login"), username_selector: Type.String({ maxLength: 500 }), password_selector: Type.String({ maxLength: 500 }), submit_selector: Type.String({ maxLength: 500 }) }),
        Type.Object({ type: Type.Literal("click"), selector: Type.String({ maxLength: 500 }) }),
        Type.Object({ type: Type.Literal("fill"), selector: Type.String({ maxLength: 500 }), value: Type.String({ maxLength: 10_000 }) }),
        Type.Object({ type: Type.Literal("select"), selector: Type.String({ maxLength: 500 }), value: Type.String({ maxLength: 10_000 }) }),
        Type.Object({ type: Type.Literal("wait_for"), selector: Type.String({ maxLength: 500 }) }),
      ]), { minItems: 1 }),
      screenshot: Type.Optional(Type.Boolean()),
    }),
    execute: (_id, input, signal) => broker(options, "playwright", input, signal),
  });
}
