import { Client as ElasticsearchClient } from "@elastic/elasticsearch";
import { createClient } from "redis";

import type { IssuePolicy } from "../pi/policy.ts";
import { capabilityResultText, MAX_ES_RESULTS, MAX_REDIS_KEYS, MAX_REDIS_RESULTS } from "./limits.ts";

function operationSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function redisCommand(config: Record<string, unknown>, command: string[], signal?: AbortSignal): Promise<unknown> {
  const username = config.username as string;
  const password = config.password as string | undefined;
  const client = createClient({
    RESP: 2,
    socket: {
      host: config.host as string,
      port: config.port as number,
      connectTimeout: 10_000,
      reconnectStrategy: false,
    },
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    database: config.database as number,
    disableClientInfo: true,
  });
  client.on("error", () => {});
  const activeSignal = operationSignal(signal);
  const abort = () => { if (client.isOpen) client.destroy(); };
  activeSignal.addEventListener("abort", abort, { once: true });
  try {
    if (activeSignal.aborted) throw activeSignal.reason;
    await client.connect();
    return await client.sendCommand(command, { abortSignal: activeSignal });
  } finally {
    activeSignal.removeEventListener("abort", abort);
    if (client.isOpen) client.destroy();
  }
}

function authHeaders(config: Record<string, unknown>): Record<string, string> {
  return config.username ? { authorization: `Basic ${Buffer.from(`${config.username}:${config.password ?? ""}`).toString("base64")}` } : {};
}

async function httpJson(config: Record<string, unknown>, requestPath: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(new URL(requestPath, `http://${config.host}:${config.managementPort}`), {
    redirect: "error",
    headers: { accept: "application/json", ...authHeaders(config) },
    signal: operationSignal(signal),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`external_http_${response.status}`);
  return text ? JSON.parse(text) as unknown : null;
}

async function elasticsearchRead(config: Record<string, unknown>, input: { action: "search" | "count" | "mapping"; query: Record<string, unknown>; limit?: number }, signal?: AbortSignal): Promise<unknown> {
  const username = config.username as string;
  const client = new ElasticsearchClient({
    node: config.url as string,
    maxRetries: 0,
    requestTimeout: 15_000,
    ...(username ? { auth: { username, password: config.password as string } } : {}),
  });
  const activeSignal = operationSignal(signal);
  const abort = () => { void client.close(); };
  activeSignal.addEventListener("abort", abort, { once: true });
  try {
    if (activeSignal.aborted) throw activeSignal.reason;
    const response = input.action === "mapping"
      ? await client.indices.getMapping()
      : input.action === "count"
        ? await client.count({ body: { query: input.query } })
        : await client.search({ body: { query: input.query, ...(input.limit === undefined ? {} : { size: input.limit }) } });
    if (activeSignal.aborted) throw activeSignal.reason;
    const statusCode = response.statusCode;
    if (typeof statusCode !== "number" || statusCode < 200 || statusCode >= 300) throw new Error(`external_http_${statusCode ?? "unknown"}`);
    return response.body;
  } finally {
    activeSignal.removeEventListener("abort", abort);
    await client.close();
  }
}

export async function readRedis(policy: IssuePolicy, config: Record<string, unknown>, input: { action: string; key?: string; keys?: string[]; field?: string; pattern?: string; cursor?: string; limit?: number }, signal?: AbortSignal) {
  const grant = policy.service.redis;
  if (!grant) throw new Error("redis_scope_not_granted_for_service");
  if (typeof config.host !== "string" || !Number.isInteger(config.port) || typeof config.username !== "string" || (config.password !== undefined && typeof config.password !== "string") || !Number.isInteger(config.database)) throw new Error("redis_configuration_changed");
  const text = (value: unknown, name: string) => { if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\0")) throw new Error(`invalid_redis_${name}`); return value; };
  let command: string[];
  if (input.action === "get" || input.action === "type" || input.action === "ttl" || input.action === "hgetall") command = [input.action.toUpperCase(), text(input.key, "key")];
  else if (input.action === "hget") command = ["HGET", text(input.key, "key"), text(input.field, "field")];
  else if (input.action === "mget") {
    if (!Array.isArray(input.keys) || !input.keys.length || input.keys.length > MAX_REDIS_KEYS) throw new Error("invalid_redis_keys");
    command = ["MGET", ...input.keys.map((key) => text(key, "key"))];
  } else if (input.action === "scan") {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REDIS_RESULTS) throw new Error("invalid_redis_limit");
    command = ["SCAN", input.cursor && /^\d+$/.test(input.cursor) ? input.cursor : "0", "MATCH", input.pattern ? text(input.pattern, "pattern") : "*", "COUNT", String(limit)];
  } else throw new Error("invalid_redis_action");
  const output = await redisCommand(config, command, signal);
  return {
    content: [{ type: "text" as const, text: capabilityResultText({ action: input.action, output }) }],
    details: { deploymentId: grant.deploymentId },
  };
}

export async function readElasticsearch(policy: IssuePolicy, config: Record<string, unknown>, input: { action: "search" | "count" | "mapping"; query?: Record<string, unknown>; limit?: number }, signal?: AbortSignal) {
  const grant = policy.service.es;
  if (!grant) throw new Error("es_scope_not_granted_for_service");
  if (typeof config.url !== "string" || typeof config.username !== "string" || (config.password !== undefined && typeof config.password !== "string")) throw new Error("es_configuration_changed");
  const query = input.query ?? { match_all: {} };
  if (!query || typeof query !== "object") throw new Error("invalid_es_query");
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_ES_RESULTS)) throw new Error("invalid_es_limit");
  const output = await elasticsearchRead(config, { action: input.action, query, ...(input.limit === undefined ? {} : { limit: input.limit }) }, signal);
  return {
    content: [{ type: "text" as const, text: capabilityResultText({ action: input.action, output }) }],
    details: { deploymentId: grant.deploymentId },
  };
}

export async function readRabbitMq(policy: IssuePolicy, config: Record<string, unknown>, input: { action: "overview" | "queues" | "queue" | "bindings"; queue?: string }, signal?: AbortSignal) {
  const grant = policy.service.mq;
  if (!grant) throw new Error("mq_scope_not_granted_for_service");
  if (config.virtualHost !== grant.virtualHost || typeof config.host !== "string" || !Number.isInteger(config.port) || !Number.isInteger(config.managementPort) || typeof config.username !== "string" || typeof config.password !== "string") throw new Error("mq_configuration_changed");
  const queue = input.queue?.trim();
  if ((input.action === "queue" || input.action === "bindings") && (!queue || queue.length > 255 || queue.includes("\0"))) throw new Error("invalid_mq_queue");
  const vhost = encodeURIComponent(config.virtualHost as string);
  const requestPath = input.action === "overview" ? "/api/overview"
    : input.action === "queues" ? `/api/queues/${vhost}`
      : input.action === "queue" ? `/api/queues/${vhost}/${encodeURIComponent(queue!)}`
        : `/api/queues/${vhost}/${encodeURIComponent(queue!)}/bindings`;
  const output = await httpJson(config, requestPath, signal);
  return {
    content: [{ type: "text" as const, text: capabilityResultText({ action: input.action, output }) }],
    details: { deploymentId: grant.deploymentId, virtualHost: grant.virtualHost },
  };
}
