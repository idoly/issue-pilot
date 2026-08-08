import { Worker } from "node:worker_threads";

import type { IssuePolicy } from "../pi/policy.ts";
import { capabilityResultText, MAX_CAPABILITY_RESULT_BYTES, MAX_ES_RESULTS, MAX_REDIS_KEYS, MAX_REDIS_RESULTS } from "./limits.ts";

function operationSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function redisCommand(config: Record<string, unknown>, action: string, command: string[], signal?: AbortSignal): Promise<string> {
  const activeSignal = operationSignal(signal);
  if (activeSignal.aborted) throw activeSignal.reason;
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL("./redis-worker.ts", import.meta.url), {
      execArgv: ["--experimental-strip-types"],
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 },
      workerData: {
        action,
        command,
        config: { host: config.host, port: config.port, username: config.username, password: config.password, database: config.database },
      },
    });
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      activeSignal.removeEventListener("abort", abort);
      operation();
      void worker.terminate();
    };
    const abort = () => finish(() => reject(activeSignal.reason));
    activeSignal.addEventListener("abort", abort, { once: true });
    worker.once("message", (message: { ok?: boolean; text?: string; error?: string }) => finish(() => message.ok && typeof message.text === "string" ? resolve(message.text) : reject(new Error(message.error ?? "redis_read_failed"))));
    worker.once("error", (error: Error) => finish(() => reject(new Error(/memory limit/i.test(error.message) ? "capability_result_too_large" : "redis_read_failed", { cause: error }))));
    worker.once("exit", (code) => { if (!settled) finish(() => reject(new Error(code === 0 ? "redis_read_failed" : "capability_result_too_large"))); });
  });
}

function authHeaders(config: Record<string, unknown>): Record<string, string> {
  return config.username ? { authorization: `Basic ${Buffer.from(`${config.username}:${config.password ?? ""}`).toString("base64")}` } : {};
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_CAPABILITY_RESULT_BYTES) throw new Error("capability_result_too_large");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await boundedResponseText(response);
  if (!response.ok) throw new Error(`external_http_${response.status}`);
  return text ? JSON.parse(text) as unknown : null;
}

async function httpJson(config: Record<string, unknown>, requestPath: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(new URL(requestPath, `http://${config.host}:${config.managementPort}`), {
    redirect: "error",
    headers: { accept: "application/json", ...authHeaders(config) },
    signal: operationSignal(signal),
  });
  return responseJson(response);
}

function elasticsearchUrl(baseUrl: string, suffix: string): URL {
  const endpoint = new URL(baseUrl);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/${suffix}`;
  return endpoint;
}

async function elasticsearchRead(config: Record<string, unknown>, input: { action: "search" | "count" | "mapping"; query: Record<string, unknown>; limit?: number }, signal?: AbortSignal): Promise<unknown> {
  const suffix = input.action === "mapping" ? "_mapping" : input.action === "count" ? "_count" : "_search";
  const body = input.action === "mapping" ? undefined : JSON.stringify({ query: input.query, ...(input.action === "search" && input.limit !== undefined ? { size: input.limit } : {}) });
  const response = await fetch(elasticsearchUrl(config.url as string, suffix), {
    method: body ? "POST" : "GET",
    redirect: "error",
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...authHeaders(config) },
    ...(body ? { body } : {}),
    signal: operationSignal(signal),
  });
  return responseJson(response);
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
  const output = await redisCommand(config, input.action, command, signal);
  return {
    content: [{ type: "text" as const, text: output }],
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
