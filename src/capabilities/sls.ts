import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilityTextResult } from "./contracts.ts";
import { runReadWorker } from "./read-worker.ts";
import { SLS_QUERY_ERRORS } from "./sls-errors.ts";
export { SLS_QUERY_ERRORS };
import type { CapabilityConfig, CapabilityInputs } from "./registry.ts";

const limits = issuePilotConfig.limits.capability.sls;
const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function prepareSlsQuery(input: CapabilityInputs["sls"], configured: CapabilityConfig<"sls">) {
  if ((input.from === undefined) !== (input.to === undefined)) throw new Error("invalid_sls_time_range");
  const now = Math.floor(Date.now() / 1000), to = input.to ?? now;
  const from = input.from ?? to - (input.trace_id ? limits.traceWindowSeconds : limits.defaultWindowSeconds);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > now + limits.futureToleranceSeconds) throw new Error("invalid_sls_time_range");
  const traceId = input.trace_id?.trim();
  if (traceId && !TRACE_ID.test(traceId)) throw new Error("invalid_sls_trace_id");
  if (traceId && input.query?.trim()) throw new Error("invalid_sls_query");
  const query = traceId || input.query?.trim() || "*";
  if (query.includes("\0")) throw new Error("invalid_sls_query");
  if (!configured.logstores.includes(input.logstore)) throw new Error("sls_logstore_not_granted");
  return { from, to, query, logstore: input.logstore, trace: Boolean(traceId) };
}
export type SlsQuery = ReturnType<typeof prepareSlsQuery>;

export async function readSlsLogs(input: CapabilityInputs["sls"], configured: CapabilityConfig<"sls">, signal?: AbortSignal) {
  const query = prepareSlsQuery(input, configured);
  const active = AbortSignal.any([AbortSignal.timeout(limits.executionMs), ...(signal ? [signal] : [])]);
  try {
    const result = await runReadWorker(new URL("./sls-worker.ts", import.meta.url), { configured, query }, issuePilotConfig.runtime.slsWorker, active, "sls_query_failed", SLS_QUERY_ERRORS);
    return capabilityTextResult(result.text, result.details ?? {});
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (active.aborted) throw new Error("sls_query_timeout");
    throw error;
  }
}
