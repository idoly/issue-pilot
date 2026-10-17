import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { readSlsHttp, type SlsSdkFactory } from "../../src/capabilities/sls-http.ts";
import type { CapabilityConfig } from "../../src/capabilities/registry.ts";
import type { SlsQuery } from "../../src/capabilities/sls.ts";
const { GetLogsV2Response } = createRequire(import.meta.url)("@alicloud/sls20201230") as typeof import("@alicloud/sls20201230");
const input = workerData as { configured: CapabilityConfig<"sls">; query: SlsQuery; hang: boolean };
const factory: SlsSdkFactory = () => ({ async getLogsV2WithOptions() {
  if (input.hang) await new Promise(() => { setInterval(() => {}, 1000); });
  return new GetLogsV2Response({ statusCode: 200, body: { data: [{ message: "worker-ready" }], meta: { hasSQL: false, progress: "Complete", mode: 0 } } });
} });
try {
  const result = await readSlsHttp(input.configured, input.query, factory);
  parentPort?.postMessage({ ok: true, text: result.content[0]!.text, details: result.details });
} catch { parentPort?.postMessage({ ok: false, error: "sls_query_failed" }); }
