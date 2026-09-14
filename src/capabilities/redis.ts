import { Worker } from "node:worker_threads";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilitySignal, capabilityTextResult } from "./contracts.ts";
import type { CapabilityConfig, CapabilityInputs } from "./registry.ts";

const limits = issuePilotConfig.limits.capability;

async function redisCommand(config: CapabilityConfig<"redis">, action: string, command: string[], signal?: AbortSignal): Promise<string> {
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
      const cursor = input.cursor && /^\d+$/.test(input.cursor) ? input.cursor : "0";
      const pattern = input.pattern ? redisArgument(input.pattern, "pattern") : "*";
      return ["SCAN", cursor, "MATCH", pattern, "COUNT", String(limit)];
    }
  }
}

export async function readRedis(config: CapabilityConfig<"redis">, input: CapabilityInputs["redis"], signal?: AbortSignal) {
  const response = await redisCommand(config, input.action, redisReadCommand(input), signal);
  return capabilityTextResult(response, {});
}
