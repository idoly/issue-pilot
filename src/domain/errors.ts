export type DomainErrorCategory = "bad_request" | "forbidden" | "not_found" | "conflict" | "payload_too_large" | "rate_limited" | "timeout" | "unavailable" | "internal" | "upstream";

const statusByCategory: Record<DomainErrorCategory, number> = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  timeout: 408,
  unavailable: 503,
  internal: 500,
  upstream: 502,
};

/** HTTP route errors carry their status; one mapping keeps the category the only transport-neutral fact. */
export function categoryForStatus(status: number): DomainErrorCategory {
  switch (status) {
    case 400:
      return "bad_request";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    case 408:
      return "timeout";
    case 503:
      return "unavailable";
    case 502:
      return "upstream";
    default:
      return "internal";
  }
}

/**
 * Owner-level failure with a stable code and one transport-neutral category.
 * HTTP maps the category once; route catalogs do not re-derive status from message text.
 * The message is the code, or `code:detail` when the owner adds a diagnostic detail that is never published.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly category: DomainErrorCategory;

  constructor(code: string, category: DomainErrorCategory, options?: ErrorOptions & { detail?: string }) {
    super(options?.detail ? `${code}:${options.detail}` : code, options);
    this.name = "DomainError";
    this.code = code;
    this.category = category;
  }

  get statusCode(): number {
    return statusByCategory[this.category];
  }
}

/** Codes whose category is not declared stay internal, preserving the old fallback. */
const categories = new Map<string, DomainErrorCategory>([
  ["source_repository_not_found", "not_found"],
  ["source_path_not_found", "not_found"],
  ["source_commit_not_found", "not_found"],
  ["source_commit_file_not_found", "not_found"],
  ["source_diff_file_not_found", "not_found"],
  ["source_browser_unavailable", "conflict"],
  ["source_repository_state_invalid", "conflict"],
  ["source_runtime_invalid", "conflict"],
  ["source_git_binding_invalid", "conflict"],
  ["source_read_only", "conflict"],
  ["source_file_changed", "conflict"],
  ["source_path_exists", "conflict"],
  ["source_path_not_empty", "conflict"],
  ["source_stage_failed", "conflict"],
  ["source_unstage_failed", "conflict"],
  ["source_discard_failed", "conflict"],
  ["source_commit_failed", "conflict"],
  ["invalid_source_path", "bad_request"],
  ["invalid_source_query", "bad_request"],
  ["invalid_source_history_cursor", "bad_request"],
  ["invalid_source_revision", "bad_request"],
  ["invalid_source_line", "bad_request"],
  ["invalid_source_hash", "bad_request"],
  ["invalid_source_commit_message", "bad_request"],
  ["invalid_source_commit_author", "bad_request"],
  ["source_path_not_directory", "bad_request"],
  ["source_path_not_file", "bad_request"],
  ["source_path_outside_repository", "bad_request"],
  ["source_file_binary", "payload_too_large"],
  ["source_file_too_large", "payload_too_large"],
  ["source_commit_too_large", "payload_too_large"],
  ["source_diff_too_large", "payload_too_large"],
  ["invalid_attachment_name", "bad_request"],
  ["issue_file_not_found", "not_found"],
  ["invalid_issue_file_path", "bad_request"],
  ["issue_file_not_directory", "bad_request"],
  ["issue_file_not_regular", "bad_request"],
  ["managed_issue_file_private", "bad_request"],
  ["issue_file_directory_too_large", "payload_too_large"],
]);

/**
 * Durable-state and cleanup failures that need operator inspection. They stay internal with diagnostics
 * wherever they surface; an owner must never republish them as a retryable refusal.
 */
export const OPERATIONAL_FAILURE_CODES: ReadonlySet<string> = new Set([
  "attachment_staging_cleanup_failed",
  "attachment_read_cleanup_failed",
  "dingtalk_connection_close_failed",
  "issue_root_missing",
  "invalid_issue_root",
  "issue_workspace_missing",
  "issue_service_not_found",
  "agent_session_file_incomplete",
  "agent_session_file_missing",
]);

export function domainError(code: string, options?: ErrorOptions): DomainError {
  return new DomainError(code, categories.get(code) ?? "internal", options);
}
