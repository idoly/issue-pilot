import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { deploymentCapabilityConfig } from "./deployment.ts";
import type { IssuePolicy } from "../pi/policy.ts";

const NODE_IMAGE = process.env.PI_NODE_CLI_IMAGE ?? "docker.io/library/node:26.5.1-bookworm-slim";

function issueWorkspace(cwd: string): void {
  if (!/^issue-(?:[0-9]{4,}|[0-9]{8}-[0-9]{3,4})$/.test(path.basename(path.resolve(cwd)).toLowerCase())) throw new Error("issue_workspace_container_not_available");
}

async function execute(pi: ExtensionAPI, cwd: string, capability: "redis" | "es" | "mq", config: Record<string, unknown>, request: Record<string, unknown>, signal?: AbortSignal) {
  issueWorkspace(cwd);
  const directory = await mkdtemp(path.join(os.tmpdir(), `issue-pilot-${capability}-`));
  try {
    const configFile = path.join(directory, "config.json");
    const requestFile = path.join(directory, "request.json");
    await Promise.all([writeFile(configFile, JSON.stringify(config), { mode: 0o600 }), writeFile(requestFile, JSON.stringify(request), { mode: 0o600 })]);
    const runner = fileURLToPath(new URL("../../infra/external-read-runner.mjs", import.meta.url));
    const execution = await pi.exec("podman", [
      "run", "--rm", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--read-only", "--tmpfs", "/tmp:size=16m,mode=1777",
      "--volume", `${runner}:/runner.mjs:ro,Z`, "--volume", `${directory}:/run:ro,Z`, NODE_IMAGE,
      "node", "/runner.mjs", capability, "/run/config.json", "/run/request.json",
    ], { ...(signal ? { signal } : {}), timeout: 30_000 });
    if (execution.code !== 0) throw new Error(`${capability}_read_failed`);
    return JSON.parse(execution.stdout || "null") as unknown;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function readRedis(pi: ExtensionAPI, policy: IssuePolicy, cwd: string, input: { action: string; key?: string; keys?: string[]; field?: string; pattern?: string; cursor?: string; limit?: number }, signal?: AbortSignal) {
  const grant = policy.service.redis;
  if (!grant) throw new Error("redis_scope_not_granted_for_service");
  const config = await deploymentCapabilityConfig(policy, grant.deploymentId, "redis");
  if (typeof config.host !== "string" || !Number.isInteger(config.port) || typeof config.username !== "string" || (config.password !== undefined && typeof config.password !== "string") || !Number.isInteger(config.database)) throw new Error("redis_configuration_changed");
  const text = (value: unknown, name: string) => { if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\0")) throw new Error(`invalid_redis_${name}`); return value; };
  let command: string[];
  if (input.action === "get" || input.action === "type" || input.action === "ttl" || input.action === "hgetall") command = [input.action.toUpperCase(), text(input.key, "key")];
  else if (input.action === "hget") command = ["HGET", text(input.key, "key"), text(input.field, "field")];
  else if (input.action === "mget") {
    if (!Array.isArray(input.keys) || !input.keys.length) throw new Error("invalid_redis_keys");
    command = ["MGET", ...input.keys.map((key) => text(key, "key"))];
  } else if (input.action === "scan") {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1) throw new Error("invalid_redis_limit");
    command = ["SCAN", input.cursor && /^\d+$/.test(input.cursor) ? input.cursor : "0", "MATCH", input.pattern ? text(input.pattern, "pattern") : "*", "COUNT", String(limit)];
  } else throw new Error("invalid_redis_action");
  const output = await execute(pi, cwd, "redis", config, { command }, signal);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ action: input.action, output }, null, 2) }],
    details: { deploymentId: grant.deploymentId },
  };
}

export async function readElasticsearch(pi: ExtensionAPI, policy: IssuePolicy, cwd: string, input: { action: "search" | "count" | "mapping"; query?: Record<string, unknown>; limit?: number }, signal?: AbortSignal) {
  const grant = policy.service.es;
  if (!grant) throw new Error("es_scope_not_granted_for_service");
  const config = await deploymentCapabilityConfig(policy, grant.deploymentId, "es");
  if (typeof config.url !== "string" || typeof config.username !== "string" || (config.password !== undefined && typeof config.password !== "string")) throw new Error("es_configuration_changed");
  const query = input.query ?? { match_all: {} };
  if (!query || typeof query !== "object") throw new Error("invalid_es_query");
  const body = input.action === "search" ? { query, ...(input.limit === undefined ? {} : { size: input.limit }) } : { query };
  const output = await execute(pi, cwd, "es", config, { action: input.action, body }, signal);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ action: input.action, output }, null, 2) }],
    details: { deploymentId: grant.deploymentId },
  };
}

export async function readRabbitMq(pi: ExtensionAPI, policy: IssuePolicy, cwd: string, input: { action: "overview" | "queues" | "queue" | "bindings"; queue?: string; limit?: number }, signal?: AbortSignal) {
  const grant = policy.service.mq;
  if (!grant) throw new Error("mq_scope_not_granted_for_service");
  const config = await deploymentCapabilityConfig(policy, grant.deploymentId, "mq");
  if (config.virtualHost !== grant.virtualHost || typeof config.host !== "string" || !Number.isInteger(config.port) || !Number.isInteger(config.managementPort) || typeof config.username !== "string" || typeof config.password !== "string") throw new Error("mq_configuration_changed");
  const queue = input.queue?.trim();
  if ((input.action === "queue" || input.action === "bindings") && (!queue || queue.length > 255 || queue.includes("\0"))) throw new Error("invalid_mq_queue");
  const output = await execute(pi, cwd, "mq", config, { action: input.action, ...(queue ? { queue } : {}) }, signal);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ action: input.action, output }, null, 2) }],
    details: { deploymentId: grant.deploymentId, virtualHost: grant.virtualHost },
  };
}
