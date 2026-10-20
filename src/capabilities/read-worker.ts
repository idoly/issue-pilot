import { Worker } from "node:worker_threads";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

let workers = 0;
const initializationErrors = new Set(["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_UNKNOWN_FILE_EXTENSION", "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"]);
export interface ReadWorkerResult { text: string; details?: Record<string, unknown> }

/** SDK requests stay off the host heap and close their sockets on cancellation. */
export function runReadWorker(module: URL, data: unknown, heap: { oldGenerationMb: number; youngGenerationMb: number }, signal: AbortSignal, failure: string, allowedErrors: readonly string[] = []): Promise<ReadWorkerResult> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (workers >= issuePilotConfig.limits.capability.workerConcurrency) return Promise.reject(new Error("capability_worker_capacity_exceeded"));
  workers++;
  let worker: Worker;
  try {
    worker = new Worker(module, { execArgv: ["--experimental-strip-types"], env: { ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}) }, workerData: data, resourceLimits: { maxOldGenerationSizeMb: heap.oldGenerationMb, maxYoungGenerationSizeMb: heap.youngGenerationMb } });
  } catch { workers--; return Promise.reject(new Error("capability_worker_initialization_failed")); }
  worker.once("exit", () => { workers--; });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => { if (settled) return; settled = true; signal.removeEventListener("abort", abort); action(); void worker.terminate().catch(() => undefined); };
    const abort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: unknown) => {
      if (message && typeof message === "object" && ("watch:import" in message || "watch:require" in message)) return;
      finish(() => {
        if (message && typeof message === "object" && "ok" in message && message.ok === true && "text" in message && typeof message.text === "string") resolve({ text: message.text, ...("details" in message && message.details && typeof message.details === "object" && !Array.isArray(message.details) ? { details: message.details as Record<string, unknown> } : {}) });
        else {
          const code = message && typeof message === "object" && "error" in message && typeof message.error === "string" ? message.error : failure;
          reject(new Error(code === "capability_result_too_large" || allowedErrors.includes(code) ? code : failure));
        }
      });
    });
    worker.once("error", (error: Error & { code?: string }) => finish(() => {
      let code = failure;
      if (error.code === "ERR_WORKER_OUT_OF_MEMORY") code = "capability_result_too_large";
      else if (error.code && initializationErrors.has(error.code)) code = "capability_worker_initialization_failed";
      reject(new Error(code));
    }));
    worker.once("exit", () => { if (!settled) finish(() => reject(new Error(failure))); });
    if (signal.aborted) abort();
  });
}
