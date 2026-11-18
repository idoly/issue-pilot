import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { applicationParameters } from "../configuration/parameters.ts";
import { DomainError } from "../domain/errors.ts";
import { localCommandExecutor, type CommandExecutor } from "../process.ts";
import { capabilityResultText, capabilityTextResult } from "./contracts.ts";
import type { CapabilityConfig } from "./registry.ts";
import type { SlsQuery } from "./sls.ts";

const limits = issuePilotConfig.limits.capability;
const TOO_LARGE = "sls_result_too_large_narrow_query";
const providerErrors = new Map<string, string>([
  ["Unauthorized", "sls_access_denied"],
  ["SignatureNotMatch", "sls_signature_mismatch"],
  ["InvalidAccessKeyId", "sls_invalid_access_key"],
  ["AccessKeyIdNotExist", "sls_invalid_access_key"],
  ["ProjectNotExist", "sls_project_not_found"],
  ["LogStoreNotExist", "sls_logstore_not_found"],
  ["IndexNotExist", "sls_index_unavailable"],
  ["InvalidParameter", "sls_invalid_request"],
  ["BadRequest", "sls_invalid_request"],
  ["ClientConfigError", "sls_client_configuration_invalid"],
  ["RequestTimeExpired", "sls_request_time_expired"],
  ["RequestTimeout", "sls_query_timeout"],
  ["Throttling", "sls_rate_limited"],
  ["QuotaExceed", "sls_quota_exceeded"],
  ["InternalServerError", "sls_service_unavailable"],
  ["ServerBusy", "sls_service_unavailable"],
]);
const networkErrors = new Map<string, string>([
  ["ETIMEDOUT", "sls_query_timeout"],
  ["ESOCKETTIMEDOUT", "sls_query_timeout"],
  ["ENOTFOUND", "sls_dns_failed"],
  ["EAI_AGAIN", "sls_dns_failed"],
  ["ECONNRESET", "sls_network_failed"],
  ["ECONNREFUSED", "sls_network_failed"],
  ["EHOSTUNREACH", "sls_network_failed"],
  ["ENETUNREACH", "sls_network_failed"],
  ["CERT_HAS_EXPIRED", "sls_tls_failed"],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "sls_tls_failed"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "sls_tls_failed"],
  ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "sls_tls_failed"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "sls_tls_failed"],
]);

function cliFailure(stderr: string): string {
  // oxlint-disable-next-line no-control-regex -- Explicit control bytes are required for sanitization and path validation.
  const diagnostic = stderr.replace(/\x1b\[[0-9;]*m/g, "");
  const code = /^\s*Code:\s*([A-Za-z][A-Za-z0-9]*)\s*$/m.exec(diagnostic)?.[1];
  const status = /^\s*StatusCode:\s*([45]\d\d)\s*$/m.exec(diagnostic)?.[1];
  return providerErrors.get(code ?? "") ?? (status ? `sls_http_${status}` : undefined) ?? networkErrors.get(code ?? "") ?? "sls_query_failed";
}

/** Invoke only the read-only GetLogsV2 action; credentials never enter argv or returned diagnostics. */
export async function readSlsCli(configured: CapabilityConfig<"sls">, query: SlsQuery, signal: AbortSignal, executor: CommandExecutor = localCommandExecutor) {
  signal.throwIfAborted();
  const directory = await mkdtemp(path.join(tmpdir(), "issue-pilot-sls-"));
  const configPath = path.join(directory, "config.json");
  const failures: unknown[] = [];
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        current: "issue-pilot",
        profiles: [
          {
            name: "issue-pilot",
            mode: "AK",
            access_key_id: configured.accessKeyId,
            access_key_secret: configured.accessKeySecret,
            region_id: configured.region,
            output_format: "json",
            language: "en",
          },
        ],
      }),
      { mode: 0o600, flag: "wx" },
    );
    const environment: Record<string, string> = { HOME: directory };
    for (const name of ["PATH", "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"])
      if (process.env[name] !== undefined) environment[name] = process.env[name]!;
    const records: unknown[] = [];
    let recordsBytesUpperBound = 0;
    let analysis = false;
    while (true) {
      signal.throwIfAborted();
      const result = await executor.execute(
        "aliyun",
        [
          "sls",
          "GetLogsV2",
          "--project",
          configured.project,
          "--logstore",
          query.logstore,
          "--region",
          configured.region,
          "--secure",
          "--config-path",
          configPath,
          "--retry-count",
          "0",
          "--read-timeout",
          String(Math.ceil(applicationParameters().slsExecutionMs / 1000)),
          "--connect-timeout",
          String(Math.ceil(applicationParameters().capabilityConnectionMs / 1000)),
          "--body",
          JSON.stringify({ from: query.from, to: query.to, query: query.query, line: limits.sls.pageResults, offset: records.length, reverse: true }),
        ],
        { signal, environment, maxOutputBytes: limits.resultBytes, strictStdoutUtf8: true },
      );
      signal.throwIfAborted();
      if (result.killed) throw new DomainError("sls_query_timeout", "upstream");
      if (result.code !== 0) throw new DomainError(cliFailure(result.stderr), "upstream");
      let response: unknown;
      try {
        response = JSON.parse(result.stdout);
      } catch {
        throw new DomainError("sls_query_invalid_response", "upstream");
      }
      if (!response || typeof response !== "object" || Array.isArray(response)) throw new DomainError("sls_query_invalid_response", "upstream");
      const { data: page, meta } = response as { data?: unknown; meta?: { hasSQL?: unknown; progress?: unknown; mode?: unknown; limited?: unknown } };
      if (!Array.isArray(page) || !meta || typeof meta.hasSQL !== "boolean") throw new DomainError("sls_query_invalid_response", "upstream");
      if (typeof meta.progress !== "string" || meta.progress.toLowerCase() !== "complete") throw new DomainError("sls_query_incomplete", "upstream");
      if ((meta.mode ?? 0) !== 0) throw new DomainError("sls_scan_query_not_supported", "upstream");
      if ((!meta.hasSQL && page.length > limits.sls.pageResults) || (records.length && meta.hasSQL)) throw new DomainError("sls_query_invalid_response", "upstream");
      if (meta.hasSQL && typeof meta.limited === "number" && meta.limited > 0 && page.length >= meta.limited) throw new DomainError("sls_sql_limit_required", "upstream");
      analysis = meta.hasSQL;
      // Separate page envelopes overestimate the merged JSON size. Only rescan the whole result near the limit.
      recordsBytesUpperBound += Buffer.byteLength(capabilityResultText({ records: page }, TOO_LARGE));
      for (const record of page) records.push(record);
      if (recordsBytesUpperBound > limits.inlineResultBytes) recordsBytesUpperBound = Buffer.byteLength(capabilityResultText({ records }, TOO_LARGE));
      if (analysis || page.length < limits.sls.pageResults) break;
    }
    const metadata = {
      region: configured.region,
      project: configured.project,
      logstore: query.logstore,
      from: query.from,
      to: query.to,
      timezone: issuePilotConfig.regional.timeZone,
      queryMode: analysis ? "analysis" : query.trace ? "trace_id_full_text" : "query",
      order: analysis ? "query_order" : "newest_first",
      pagination: analysis ? "sql_limit" : "offset",
      returnedRows: records.length,
      possiblyIncomplete: false,
    };
    return capabilityTextResult(capabilityResultText({ query: metadata, records }, TOO_LARGE), { provider: "aliyun-sls-cli", ...metadata });
  } catch (error) {
    failures.push(error);
    throw error;
  } finally {
    // One owner releases the profile exactly once, on every outcome.
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      // oxlint-disable-next-line no-unsafe-finally -- Preserve both failures while making failed credential cleanup dominant.
      throw new DomainError("sls_credential_cleanup_failed", "internal", { cause: failures.length ? new AggregateError([...failures, cleanupError]) : cleanupError });
    }
  }
}
