import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { localCommandExecutor, type CommandExecutor } from "../process.ts";
import { capabilityResultText, capabilityTextResult } from "./contracts.ts";
import type { CapabilityConfig } from "./registry.ts";
import type { SlsQuery } from "./sls.ts";
import { slsFailureCode } from "./sls-errors.ts";

const limits = issuePilotConfig.limits.capability;
function cliFailure(stderr: string): string {
  const diagnostic = stderr.replace(/\x1b\[[0-9;]*m/g, "");
  const code = /^\s*Code:\s*([A-Za-z][A-Za-z0-9]*)\s*$/m.exec(diagnostic)?.[1];
  const status = /^\s*StatusCode:\s*([45]\d\d)\s*$/m.exec(diagnostic)?.[1];
  return slsFailureCode({ code, statusCode: status });
}

/** Invoke only the read-only GetLogsV2 action; credentials never enter argv or returned diagnostics. */
export async function readSlsCli(configured: CapabilityConfig<"sls">, query: SlsQuery, signal: AbortSignal, executor: CommandExecutor = localCommandExecutor) {
  signal.throwIfAborted();
  const directory = await mkdtemp(path.join(tmpdir(), "issue-pilot-sls-"));
  const configPath = path.join(directory, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ current: "issue-pilot", profiles: [{ name: "issue-pilot", mode: "AK", access_key_id: configured.accessKeyId, access_key_secret: configured.accessKeySecret, region_id: configured.region, output_format: "json", language: "en" }] }), { mode: 0o600, flag: "wx" });
    const environment: Record<string, string> = { HOME: directory };
    for (const name of ["PATH", "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"]) if (process.env[name] !== undefined) environment[name] = process.env[name]!;
    const records: unknown[] = [];
    let analysis = false;
    while (true) {
      signal.throwIfAborted();
      const result = await executor.execute("aliyun", ["sls", "GetLogsV2", "--project", configured.project, "--logstore", query.logstore, "--region", configured.region, "--secure", "--config-path", configPath, "--retry-count", "0", "--read-timeout", String(Math.ceil(limits.sls.executionMs / 1000)), "--connect-timeout", String(Math.ceil(limits.connectionMs / 1000)), "--body", JSON.stringify({ from: query.from, to: query.to, query: query.query, line: limits.sls.pageResults, offset: records.length, reverse: true })], { signal, environment, maxOutputBytes: limits.resultBytes, strictStdoutUtf8: true });
      signal.throwIfAborted();
      if (result.killed) throw new Error("sls_query_timeout");
      if (result.code !== 0) throw new Error(cliFailure(result.stderr));
      let response: unknown;
      try { response = JSON.parse(result.stdout); } catch { throw new Error("sls_query_invalid_response"); }
      if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("sls_query_invalid_response");
      const { data: page, meta } = response as { data?: unknown; meta?: { hasSQL?: unknown; progress?: unknown; mode?: unknown; limited?: unknown } };
      if (!Array.isArray(page) || !meta || typeof meta.hasSQL !== "boolean") throw new Error("sls_query_invalid_response");
      if (typeof meta.progress !== "string" || meta.progress.toLowerCase() !== "complete") throw new Error("sls_query_incomplete");
      if ((meta.mode ?? 0) !== 0) throw new Error("sls_scan_query_not_supported");
      if (!meta.hasSQL && page.length > limits.sls.pageResults || records.length && meta.hasSQL) throw new Error("sls_query_invalid_response");
      if (meta.hasSQL && typeof meta.limited === "number" && meta.limited > 0 && page.length >= meta.limited) throw new Error("sls_sql_limit_required");
      analysis = meta.hasSQL;
      records.push(...page);
      capabilityResultText({ records });
      if (analysis || page.length < limits.sls.pageResults) break;
    }
    const metadata = { ...(query.target ? { target: query.target } : {}), project: configured.project, logstore: query.logstore, from: query.from, to: query.to, timezone: issuePilotConfig.regional.timeZone, queryMode: analysis ? "analysis" : query.trace ? "trace_id_full_text" : "query", order: analysis ? "query_order" : "newest_first", pagination: analysis ? "sql_limit" : "offset", returnedRows: records.length, possiblyIncomplete: false };
    return capabilityTextResult(capabilityResultText({ query: metadata, records }), { provider: "aliyun-sls-cli", ...metadata });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
