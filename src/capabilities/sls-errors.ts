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
  ["ETIMEDOUT", "sls_query_timeout"], ["ESOCKETTIMEDOUT", "sls_query_timeout"],
  ["ENOTFOUND", "sls_dns_failed"], ["EAI_AGAIN", "sls_dns_failed"],
  ["ECONNRESET", "sls_network_failed"], ["ECONNREFUSED", "sls_network_failed"],
  ["EHOSTUNREACH", "sls_network_failed"], ["ENETUNREACH", "sls_network_failed"],
  ["CERT_HAS_EXPIRED", "sls_tls_failed"], ["DEPTH_ZERO_SELF_SIGNED_CERT", "sls_tls_failed"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "sls_tls_failed"], ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "sls_tls_failed"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "sls_tls_failed"],
]);

export const SLS_QUERY_ERRORS: readonly string[] = [
  "sls_query_failed", "sls_query_incomplete", "sls_query_invalid_response", "sls_sql_limit_required", "sls_scan_query_not_supported",
  ...new Set([...providerErrors.values(), ...networkErrors.values()]),
  ...Array.from({ length: 200 }, (_, index) => `sls_http_${400 + index}`),
];

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function slsHttpErrorCode(status: unknown): string | undefined {
  const value = typeof status === "number" ? status : typeof status === "string" && /^[45]\d{2}$/.test(status) ? Number(status) : NaN;
  return Number.isInteger(value) && value >= 400 && value <= 599 ? `sls_http_${value}` : undefined;
}

/** Use structured, allowlisted fields; never copy SDK messages, request data or headers. */
export function slsFailureCode(error: unknown): string {
  const pending: unknown[] = [error], seen = new Set<unknown>();
  while (pending.length) {
    const current = pending.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const failure = record(current);
    if (!failure) continue;
    const data = record(failure.data), code = failure.code ?? data?.Code ?? data?.code;
    if (typeof code === "string") {
      const provider = providerErrors.get(code);
      if (provider) return provider;
    }
    const http = slsHttpErrorCode(failure.statusCode ?? data?.statusCode);
    if (http) return http;
    if (typeof code === "string") {
      const network = networkErrors.get(code);
      if (network) return network;
    }
    if (failure.cause) pending.push(failure.cause);
    if (Array.isArray(failure.errors)) pending.push(...failure.errors);
  }
  return "sls_query_failed";
}
