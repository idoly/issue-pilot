import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilitySignal, capabilityTextResult } from "./contracts.ts";
import { runReadWorker } from "./read-worker.ts";
import type { CapabilityConfig, CapabilityInputs } from "./registry.ts";

const limits = issuePilotConfig.limits.capability;

async function redisCommand(config: CapabilityConfig<"redis">, action: string, command: string[], signal?: AbortSignal): Promise<string> {
  const result = await runReadWorker(new URL("./redis-worker.ts", import.meta.url), {
    action, command, connectTimeoutMs: limits.connectionMs,
    config: { host: config.host, port: config.port, username: config.username, password: config.password, database: config.database },
  }, issuePilotConfig.runtime.redisWorker, capabilitySignal(signal), "redis_read_failed");
  return result.text;
}

function redisArgument(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new Error(`invalid_redis_${name}`);
  return value;
}

function redisReadCommand(input: CapabilityInputs["redis"]): string[] {
  switch (input.action) {
    case "get":
    case "type":
    case "ttl":
    case "hgetall":
      return [input.action.toUpperCase(), redisArgument(input.key, "key")];
    case "hget":
      return ["HGET", redisArgument(input.key, "key"), redisArgument(input.field, "field")];
    case "mget":
      if (!input.keys?.length) throw new Error("invalid_redis_keys");
      return ["MGET", ...input.keys.map((key) => redisArgument(key, "key"))];
    case "scan": {
      const limit = input.limit ?? issuePilotConfig.defaults.redis.scanResults;
      if (input.cursor !== undefined && !/^\d+$/.test(input.cursor)) throw new Error("invalid_redis_cursor");
      const cursor = input.cursor ?? "0";
      const pattern = input.pattern ? redisArgument(input.pattern, "pattern") : "*";
      return ["SCAN", cursor, "MATCH", pattern, "COUNT", String(limit)];
    }
  }
}

export async function readRedis(config: CapabilityConfig<"redis">, input: CapabilityInputs["redis"], signal?: AbortSignal) {
  const response = await redisCommand(config, input.action, redisReadCommand(input), signal);
  return capabilityTextResult(response, {});
}
