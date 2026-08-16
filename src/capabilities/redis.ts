import { Worker } from "node:worker_threads";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { IssuePolicy } from "../pi/policy.ts";
import { capabilitySignal, capabilityTextResult } from "./contracts.ts";

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
      void worker.terminate().catch(() => undefined);
    };
    const abort = () => finish(() => reject(activeSignal.reason));
    activeSignal.addEventListener("abort", abort, { once: true });
    worker.once("message", (message: unknown) => finish(() => {
      if (message && typeof message === "object" && "ok" in message && message.ok === true && "text" in message && typeof message.text === "string") resolve(message.text);
      else reject(new Error(message && typeof message === "object" && "error" in message && message.error === "capability_result_too_large" ? "capability_result_too_large" : "redis_read_failed"));
    }));
    worker.once("error", (error: Error & { code?: string }) => finish(() => reject(new Error(error.code === "ERR_WORKER_OUT_OF_MEMORY" || /memory limit/i.test(error.message) ? "capability_result_too_large" : "redis_read_failed", { cause: error }))));
    worker.once("exit", () => { if (!settled) finish(() => reject(new Error("redis_read_failed"))); });
  });
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
