import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { readSlsCli } from "./sls-cli.ts";
import type { CommandExecutor } from "../process.ts";
import { SLS_QUERY_ERRORS } from "./sls-errors.ts";
export { SLS_QUERY_ERRORS };
import type { CapabilityConfig, CapabilityInputs } from "./registry.ts";

const limits = issuePilotConfig.limits.capability.sls;
const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function selectTarget(input: CapabilityInputs["sls"], configured: CapabilityConfig<"sls">): CapabilityConfig<"sls"> {
  if (!configured.targets) {
    if (input.target !== undefined) throw new Error("sls_target_not_granted");
    return configured;
  }
  const target = configured.targets.find(target => target.name === input.target);
  if (!target) throw new Error("sls_target_not_granted");
  return { ...configured, ...target };
}

export function prepareSlsQuery(input: CapabilityInputs["sls"], configured: CapabilityConfig<"sls">) {
  configured = selectTarget(input, configured);
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
  return { from, to, query, logstore: input.logstore, trace: Boolean(traceId), ...(input.target ? { target: input.target } : {}) };
}
export type SlsQuery = ReturnType<typeof prepareSlsQuery>;

export async function readSlsLogs(input: CapabilityInputs["sls"], configured: CapabilityConfig<"sls">, signal?: AbortSignal, executor?: CommandExecutor) {
  const query = prepareSlsQuery(input, configured);
  const selected = selectTarget(input, configured);
  const active = AbortSignal.any([AbortSignal.timeout(limits.executionMs), ...(signal ? [signal] : [])]);
  try {
    return await readSlsCli(selected, query, active, executor);
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (active.aborted) throw new Error("sls_query_timeout");
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new Error("sls_cli_not_available");
    if (error instanceof Error && (SLS_QUERY_ERRORS.includes(error.message) || error.message === "capability_result_too_large" || error.message === "command_output_too_large")) throw error;
    throw new Error("sls_query_failed");
  }
}
