import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { ToolRuntime } from "../tool-runtime.ts";
import { runAliyunCli, withAliyunCliProfile } from "./aliyun.ts";
import { capabilityResultText, capabilityTextResult } from "./contracts.ts";
import type { CapabilityConfig, CapabilityInputs } from "./registry.ts";

const limits = issuePilotConfig.limits.capability.sls;
const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function readSlsLogs(tools: ToolRuntime, input: CapabilityInputs["sls"], configured: CapabilityConfig<"sls">, signal?: AbortSignal) {
  if ((input.from === undefined) !== (input.to === undefined)) throw new Error("invalid_sls_time_range");
  const now = Math.floor(Date.now() / 1000);
  const to = input.to ?? now;
  const from = input.from ?? to - (input.trace_id ? limits.traceWindowSeconds : limits.defaultWindowSeconds);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) throw new Error("invalid_sls_time_range");
  if (to > now + limits.futureToleranceSeconds) throw new Error("invalid_sls_time_range");
  const traceId = input.trace_id?.trim();
  if (traceId && !TRACE_ID.test(traceId)) throw new Error("invalid_sls_trace_id");
  if (traceId && input.query?.trim()) throw new Error("invalid_sls_query");
  const searchQuery = traceId || input.query?.trim() || "*";
  if (searchQuery.includes("\0")) throw new Error("invalid_sls_query");

  if (!configured.logstores.includes(input.logstore)) throw new Error("sls_logstore_not_granted");
  const timeoutSignal = AbortSignal.timeout(limits.executionMs);
  const querySignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  return withAliyunCliProfile({
    accessKeyId: configured.accessKeyId,
    accessKeySecret: configured.accessKeySecret,
    region: configured.region,
  }, async (profileRoot) => {
    const fetchRecords = async (line: number, offset: number): Promise<unknown[]> => {
      const execution = await runAliyunCli(tools, profileRoot, [
        "sls", "GetLogs",
        "--endpoint", `${configured.region}.log.aliyuncs.com`,
        "--project", configured.project,
        "--logstore", input.logstore,
        "--from", String(from),
        "--to", String(to),
        "--query", searchQuery,
        "--line", String(line),
        "--offset", String(offset),
        "--reverse", "true",
      ], { timeout: limits.executionMs, signal: querySignal });
      if (execution.code !== 0) throw new Error("sls_query_failed");
      let parsed: unknown;
      try { parsed = JSON.parse(execution.stdout); } catch { throw new Error("sls_query_invalid_response"); }
      if (!Array.isArray(parsed)) throw new Error("sls_query_invalid_response");
      return parsed;
    };
    const records: unknown[] = [];
    const queryMetadata = () => ({
      project: configured.project,
      logstore: input.logstore,
      from,
      to,
      timezone: issuePilotConfig.regional.timeZone,
      queryMode: traceId ? "trace_id_full_text" : "query",
      order: "newest_first",
      returnedRows: records.length,
      possiblyIncomplete: false,
    });
    while (true) {
      const page = await fetchRecords(limits.pageResults, records.length);
      if (page.length > limits.pageResults) throw new Error("sls_query_invalid_response");
      records.push(...page);
      capabilityResultText({ query: queryMetadata(), records });
      if (page.length < limits.pageResults) break;
    }
    const metadata = queryMetadata();
    const text = capabilityResultText({ query: metadata, records });
    return capabilityTextResult(text, { provider: "aliyun-sls", ...metadata });
  });
}
