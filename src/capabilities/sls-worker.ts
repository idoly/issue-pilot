import { parentPort, workerData } from "node:worker_threads";
import { readSlsHttp } from "./sls-http.ts";
import { SLS_QUERY_ERRORS } from "./sls-errors.ts";
import type { SlsQuery } from "./sls.ts";
import type { CapabilityConfig } from "./registry.ts";

const input = workerData as { configured: CapabilityConfig<"sls">; query: SlsQuery };
try {
  const result = await readSlsHttp(input.configured, input.query);
  parentPort?.postMessage({ ok: true, text: result.content[0]!.type === "text" ? result.content[0]!.text : "", details: result.details });
} catch (error) {
  const code = error instanceof Error ? error.message : "sls_query_failed";
  parentPort?.postMessage({ ok: false, error: code === "capability_result_too_large" || SLS_QUERY_ERRORS.some(value => value === code) ? code : "sls_query_failed" });
}
