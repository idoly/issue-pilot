import { createRequire } from "node:module";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilityResultText, capabilityTextResult } from "./contracts.ts";
import type { CapabilityConfig } from "./registry.ts";
import type { SlsQuery } from "./sls.ts";

const require = createRequire(import.meta.url);
const { default: Client, GetLogsV2Request, GetLogsV2Headers } = require("@alicloud/sls20201230") as typeof import("@alicloud/sls20201230");
const { $OpenApiUtil } = require("@alicloud/openapi-core") as typeof import("@alicloud/openapi-core");
const { RuntimeOptions } = require("@darabonba/typescript") as typeof import("@darabonba/typescript");
const limits = issuePilotConfig.limits.capability;
export type SlsSdkFactory = (config: ConstructorParameters<typeof Client>[0]) => Pick<InstanceType<typeof Client>, "getLogsV2WithOptions">;

/** Only the signed, read-only GetLogsV2 endpoint is exposed by this adapter. */
export async function readSlsHttp(configured: CapabilityConfig<"sls">, query: SlsQuery, createClient: SlsSdkFactory = config => new Client(config)) {
  const client = createClient(new $OpenApiUtil.Config({ accessKeyId: configured.accessKeyId, accessKeySecret: configured.accessKeySecret, endpoint: `${configured.region}.log.aliyuncs.com`, protocol: "https" }));
  const runtime = new RuntimeOptions({ autoretry: false, ignoreSSL: false, readTimeout: limits.sls.executionMs, connectTimeout: limits.connectionMs, keepAlive: false });
  const records: unknown[] = [];
  let analysis = false;
  while (true) {
    let response;
    try { response = await client.getLogsV2WithOptions(configured.project, query.logstore, new GetLogsV2Request({ from: query.from, to: query.to, query: query.query, line: limits.sls.pageResults, offset: records.length, reverse: true }), new GetLogsV2Headers({}), runtime); }
    catch { throw new Error("sls_query_failed"); }
    const page = response.body?.data, meta = response.body?.meta;
    if (response.statusCode !== 200 || !Array.isArray(page) || !meta || typeof meta.hasSQL !== "boolean") throw new Error("sls_query_invalid_response");
    const progress = meta.progress ?? response.headers?.["x-log-progress"];
    if (typeof progress !== "string" || progress.toLowerCase() !== "complete") throw new Error("sls_query_incomplete");
    if ((meta.mode ?? 0) !== 0) throw new Error("sls_scan_query_not_supported");
    if (!meta.hasSQL && page.length > limits.sls.pageResults) throw new Error("sls_query_invalid_response");
    if (meta.hasSQL && typeof meta.limited === "number" && meta.limited > 0 && page.length >= meta.limited) throw new Error("sls_sql_limit_required");
    if (records.length && meta.hasSQL) throw new Error("sls_query_invalid_response");
    analysis = meta.hasSQL;
    for (const record of page) records.push(record);
    capabilityResultText({ records });
    // Offset is ignored for SQL analysis; its LIMIT/ORDER BY define the result.
    if (analysis || page.length < limits.sls.pageResults) break;
  }
  const metadata = { project: configured.project, logstore: query.logstore, from: query.from, to: query.to, timezone: issuePilotConfig.regional.timeZone, queryMode: analysis ? "analysis" : query.trace ? "trace_id_full_text" : "query", order: analysis ? "query_order" : "newest_first", pagination: analysis ? "sql_limit" : "offset", returnedRows: records.length, possiblyIncomplete: false };
  return capabilityTextResult(capabilityResultText({ query: metadata, records }), { provider: "aliyun-sls-http", ...metadata });
}
