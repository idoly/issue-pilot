import { Worker } from "node:worker_threads";

import type { IssuePolicy } from "../pi/policy.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilityResultText, capabilitySignal, capabilityTextResult, isNacosTarget } from "./contracts.ts";

const limits = issuePilotConfig.limits.capability;

async function redisCommand(config: Record<string, unknown>, action: string, command: string[], signal?: AbortSignal): Promise<string> {
  const activeSignal = capabilitySignal(signal);
  if (activeSignal.aborted) throw activeSignal.reason;
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL("./redis-worker.ts", import.meta.url), {
      execArgv: ["--experimental-strip-types"],
      resourceLimits: {
        maxOldGenerationSizeMb: issuePilotConfig.runtime.redisWorker.oldGenerationMb,
        maxYoungGenerationSizeMb: issuePilotConfig.runtime.redisWorker.youngGenerationMb,
      },
      workerData: {
        action,
        command,
        connectTimeoutMs: limits.connectionMs,
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

async function boundedResponseText(response: Response, maximum = limits.resultBytes): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw new Error("capability_result_too_large");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export interface NacosConnection {
  serverUrl: string;
  namespace: string;
  group: string;
  username: string;
  password: string;
  dataIds: string[];
}

function nacosOrigin(value: string): string {
  const server = new URL(value.includes("://") ? value : `http://${value}`);
  if (!["http:", "https:"].includes(server.protocol) || !server.hostname || server.username || server.password || server.search || server.hash || !["", "/"].includes(server.pathname)) throw new Error("invalid_nacos_server");
  if (!server.port) server.port = server.protocol === "https:" ? "443" : "8848";
  return server.origin;
}

async function nacosAccessToken(origin: string, connection: NacosConnection, signal: AbortSignal): Promise<string> {
  if (!connection.username) return "";
  const response = await fetch(new URL("/nacos/v1/auth/login", origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: connection.username, password: connection.password }),
    redirect: "error",
    signal,
  });
  const text = await boundedResponseText(response, limits.nacos.loginResponseBytes);
  if (!response.ok) throw new Error(`nacos_login_failed:${response.status}`);
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new Error("nacos_login_response_invalid"); }
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const tokenData = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
  const token = typeof record.accessToken === "string" ? record.accessToken : typeof tokenData.accessToken === "string" ? tokenData.accessToken : "";
  if (!token) throw new Error("nacos_login_token_missing");
  return token;
}

export async function readNacosConfigurations(connection: NacosConnection, signal?: AbortSignal): Promise<Array<{ dataId: string; group: string; content: string | null }>> {
  if (!isNacosTarget(connection.group)
    || !Array.isArray(connection.dataIds)
    || !connection.dataIds.length
    || connection.dataIds.length > limits.nacos.dataIds
    || connection.dataIds.some((dataId) => !isNacosTarget(dataId))
    || new Set(connection.dataIds).size !== connection.dataIds.length) throw new Error("invalid_nacos_configuration_target");
  const origin = nacosOrigin(connection.serverUrl);
  const activeSignal = capabilitySignal(signal);
  const accessToken = await nacosAccessToken(origin, connection, activeSignal);
  const configurations: Array<{ dataId: string; group: string; content: string | null }> = [];
  let remainingBytes = limits.resultBytes;
  for (const dataId of connection.dataIds) {
    const endpoint = new URL("/nacos/v1/cs/configs", origin);
    endpoint.searchParams.set("dataId", dataId);
    endpoint.searchParams.set("group", connection.group);
    if (connection.namespace) endpoint.searchParams.set("tenant", connection.namespace);
    if (accessToken) endpoint.searchParams.set("accessToken", accessToken);
    const response = await fetch(endpoint, { redirect: "error", signal: activeSignal });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      configurations.push({ dataId, group: connection.group, content: null });
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`nacos_configuration_read_failed:${response.status}`);
    }
    const content = await boundedResponseText(response, remainingBytes);
    remainingBytes -= Buffer.byteLength(content);
    configurations.push({ dataId, group: connection.group, content });
  }
  return configurations;
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
    signal: capabilitySignal(signal),
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
  const requestBody = input.action === "mapping" ? undefined : JSON.stringify({ query: input.query, ...(input.action === "search" && input.limit !== undefined ? { size: input.limit } : {}) });
  const response = await fetch(elasticsearchUrl(config.url as string, suffix), {
    method: requestBody ? "POST" : "GET",
    redirect: "error",
    headers: { accept: "application/json", ...(requestBody ? { "content-type": "application/json" } : {}), ...authHeaders(config) },
    ...(requestBody ? { body: requestBody } : {}),
    signal: capabilitySignal(signal),
  });
  return responseJson(response);
}

interface RedisReadInput {
  action: string;
  key?: string;
  keys?: string[];
  field?: string;
  pattern?: string;
  cursor?: string;
  limit?: number;
}

function redisArgument(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.length > limits.redis.keyChars || value.includes("\0")) throw new Error(`invalid_redis_${name}`);
  return value;
}

function redisReadCommand(input: RedisReadInput): string[] {
  switch (input.action) {
    case "get":
    case "type":
    case "ttl":
    case "hgetall":
      return [input.action.toUpperCase(), redisArgument(input.key, "key")];
    case "hget":
      return ["HGET", redisArgument(input.key, "key"), redisArgument(input.field, "field")];
    case "mget":
      if (!input.keys?.length || input.keys.length > limits.redis.keys) throw new Error("invalid_redis_keys");
      return ["MGET", ...input.keys.map((key) => redisArgument(key, "key"))];
    case "scan": {
      const limit = input.limit ?? issuePilotConfig.defaults.redis.scanResults;
      if (!Number.isInteger(limit) || limit < 1 || limit > limits.redis.results) throw new Error("invalid_redis_limit");
      const cursor = input.cursor && /^\d+$/.test(input.cursor) ? input.cursor : "0";
      const pattern = input.pattern ? redisArgument(input.pattern, "pattern") : "*";
      return ["SCAN", cursor, "MATCH", pattern, "COUNT", String(limit)];
    }
    default:
      throw new Error("invalid_redis_action");
  }
}

export async function readRedis(policy: IssuePolicy, config: Record<string, unknown>, input: RedisReadInput, signal?: AbortSignal) {
  const grant = policy.service.redis;
  if (!grant) throw new Error("redis_scope_not_granted_for_service");
  if (typeof config.host !== "string" || !Number.isInteger(config.port) || typeof config.username !== "string" || (config.password !== undefined && typeof config.password !== "string") || !Number.isInteger(config.database)) throw new Error("redis_configuration_changed");
  const response = await redisCommand(config, input.action, redisReadCommand(input), signal);
  return capabilityTextResult(response, { deploymentId: grant.deploymentId });
}

export async function readElasticsearch(policy: IssuePolicy, config: Record<string, unknown>, input: { action: "search" | "count" | "mapping"; query?: Record<string, unknown>; limit?: number }, signal?: AbortSignal) {
  const grant = policy.service.es;
  if (!grant) throw new Error("es_scope_not_granted_for_service");
  if (typeof config.url !== "string" || typeof config.username !== "string" || (config.password !== undefined && typeof config.password !== "string")) throw new Error("es_configuration_changed");
  const query = input.query ?? { match_all: {} };
  if (!query || typeof query !== "object") throw new Error("invalid_es_query");
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > limits.elasticsearch.results)) throw new Error("invalid_es_limit");
  const response = await elasticsearchRead(config, { action: input.action, query, ...(input.limit === undefined ? {} : { limit: input.limit }) }, signal);
  return capabilityTextResult(capabilityResultText({ action: input.action, output: response }), { deploymentId: grant.deploymentId });
}

function rabbitMqPath(action: "overview" | "queues" | "queue" | "bindings", virtualHost: string, queue?: string): string {
  const encodedVirtualHost = encodeURIComponent(virtualHost);
  if (action === "overview") return "/api/overview";
  if (action === "queues") return `/api/queues/${encodedVirtualHost}`;
  const encodedQueue = encodeURIComponent(queue!);
  return action === "queue"
    ? `/api/queues/${encodedVirtualHost}/${encodedQueue}`
    : `/api/queues/${encodedVirtualHost}/${encodedQueue}/bindings`;
}

export async function readRabbitMq(policy: IssuePolicy, config: Record<string, unknown>, input: { action: "overview" | "queues" | "queue" | "bindings"; queue?: string }, signal?: AbortSignal) {
  const grant = policy.service.mq;
  if (!grant) throw new Error("mq_scope_not_granted_for_service");
  if (config.virtualHost !== grant.virtualHost || typeof config.host !== "string" || !Number.isInteger(config.port) || !Number.isInteger(config.managementPort) || typeof config.username !== "string" || typeof config.password !== "string") throw new Error("mq_configuration_changed");
  const queue = input.queue?.trim();
  if ((input.action === "queue" || input.action === "bindings") && (!queue || queue.length > limits.rabbitmq.queueChars || queue.includes("\0"))) throw new Error("invalid_mq_queue");
  const requestPath = rabbitMqPath(input.action, config.virtualHost as string, queue);
  const response = await httpJson(config, requestPath, signal);
  return capabilityTextResult(capabilityResultText({ action: input.action, output: response }), { deploymentId: grant.deploymentId, virtualHost: grant.virtualHost });
}
