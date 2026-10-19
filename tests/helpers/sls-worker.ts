import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { readSlsHttp, type SlsSdkFactory } from "../../src/capabilities/sls-http.ts";
import type { CapabilityConfig } from "../../src/capabilities/registry.ts";
import { SLS_QUERY_ERRORS } from "../../src/capabilities/sls-errors.ts";
import type { SlsQuery } from "../../src/capabilities/sls.ts";
const { GetLogsV2Response } = createRequire(import.meta.url)("@alicloud/sls20201230") as typeof import("@alicloud/sls20201230");
const input = workerData as { configured: CapabilityConfig<"sls">; query: SlsQuery; hang: boolean; failure?: Record<string, unknown> };
const factory: SlsSdkFactory = () => ({ async getLogsV2WithOptions() {
  if (input.failure) throw Object.assign(new Error("private worker diagnostic"), input.failure);
  if (input.hang) await new Promise(() => { setInterval(() => {}, 1000); });
  return new GetLogsV2Response({ statusCode: 200, body: { data: [{ message: "worker-ready" }], meta: { hasSQL: false, progress: "Complete", mode: 0 } } });
} });
try {
  const result = await readSlsHttp(input.configured, input.query, factory);
  parentPort?.postMessage({ ok: true, text: result.content[0]!.text, details: result.details });
} catch (error) {
  const code = error instanceof Error ? error.message : "sls_query_failed";
  parentPort?.postMessage({ ok: false, error: code === "capability_result_too_large" || SLS_QUERY_ERRORS.includes(code) ? code : "sls_query_failed" });
}
