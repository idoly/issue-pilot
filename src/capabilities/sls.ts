import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { IssuePolicy } from "../pi/policy.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilityResultText, capabilityTextResult, isSlsLogstore } from "./contracts.ts";
import type { CommandExecutor } from "./local-exec.ts";

const limits = issuePilotConfig.limits.capability.sls;
const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SlsRuntime {
  cliPath: string;
}

async function secureFile(file: string): Promise<void> {
  const metadata = await stat(file);
  if (!metadata.isFile() || (metadata.mode & 0o022) !== 0) throw new Error("insecure_aliyun_cli_file");
}

export async function readSlsLogs(executor: CommandExecutor, policy: IssuePolicy, input: {
  logstore: string;
  from?: number;
  to?: number;
  query?: string;
  trace_id?: string;
  limit?: number;
}, configured: Record<string, unknown>, signal?: AbortSignal, runtime: SlsRuntime = { cliPath: issuePilotConfig.runtime.aliyunCli }) {
  if (!isSlsLogstore(input.logstore)) throw new Error("invalid_sls_logstore");
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
  const limit = input.limit ?? limits.defaultResults;
  if (!Number.isInteger(limit) || limit < 1 || limit > limits.results) throw new Error("invalid_sls_limit");

  const scope = policy.service.sls;
  if (!scope) throw new Error("sls_scope_not_granted_for_service");
  if (configured.region !== scope.region || configured.project !== scope.project || !Array.isArray(configured.logstores) || !configured.logstores.includes(input.logstore) || !scope.logstores.includes(input.logstore) || typeof configured.accessKeyId !== "string" || typeof configured.accessKeySecret !== "string") throw new Error("sls_configuration_changed");
  await secureFile(runtime.cliPath);
  // Isolate each credential profile from the operator's persistent Aliyun CLI state.
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-aliyun-"));
  const aliyunRoot = path.join(profileRoot, ".aliyun");
  await mkdir(aliyunRoot, { mode: 0o700 });
  await writeFile(path.join(aliyunRoot, "config.json"), JSON.stringify({ current: "issue-pilot", profiles: [{ name: "issue-pilot", mode: "AK", region_id: scope.region, output_format: "json", language: "en", site: "China", access_key_id: configured.accessKeyId, access_key_secret: configured.accessKeySecret }] }), { mode: 0o600 });
  try {
    const fetchRecords = async (line: number, offset: number): Promise<unknown[]> => {
      const execution = await executor.execute(runtime.cliPath, [
        "sls", "GetLogs",
        "--endpoint", `${scope.region}.log.aliyuncs.com`,
        "--project", scope.project,
        "--logstore", input.logstore,
        "--from", String(from),
        "--to", String(to),
        "--query", searchQuery,
        "--line", String(line),
        "--offset", String(offset),
        "--reverse", "true",
      ], {
        timeout: limits.executionMs,
        environment: { HOME: profileRoot, ALIBABA_CLOUD_ORIGINAL_PRODUCT_HELP: "true" },
        ...(signal ? { signal } : {}),
      });
      if (execution.code !== 0) throw new Error("sls_query_failed");
      let parsed: unknown;
      try { parsed = JSON.parse(execution.stdout); } catch { throw new Error("sls_query_invalid_response"); }
      if (!Array.isArray(parsed)) throw new Error("sls_query_invalid_response");
      return parsed;
    };
    const records: unknown[] = [];
    while (records.length < limit) {
      const pageSize = Math.min(limits.pageResults, limit - records.length);
      const page = await fetchRecords(pageSize, records.length);
      if (page.length > pageSize) throw new Error("capability_result_too_large");
      records.push(...page);
      if (page.length < pageSize) break;
    }
    if (records.length === limit && (await fetchRecords(1, limit)).length) throw new Error("capability_result_too_large");
    const queryMetadata = {
      project: scope.project,
      logstore: input.logstore,
      from,
      to,
      timezone: issuePilotConfig.regional.timeZone,
      queryMode: traceId ? "trace_id_full_text" : "query",
      order: "newest_first",
      limit,
      returnedRows: records.length,
      possiblyIncomplete: false,
    };
    const text = capabilityResultText({ query: queryMetadata, records });
    return capabilityTextResult(text, { provider: "aliyun-sls", ...queryMetadata, runtime: "local-cli" });
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
}
