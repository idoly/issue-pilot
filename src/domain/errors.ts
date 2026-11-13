export type DomainErrorCategory = "bad_request" | "not_found" | "conflict" | "payload_too_large" | "internal";

const statusByCategory: Record<DomainErrorCategory, number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  internal: 500,
};

/**
 * Owner-level failure with a stable code and one transport-neutral category.
 * HTTP maps the category once; route catalogs do not re-derive status from message text.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly category: DomainErrorCategory;

  constructor(code: string, category: DomainErrorCategory, options?: ErrorOptions) {
    super(code, options);
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
  ["invalid_issue_file_path", "bad_request"],
  ["issue_file_not_directory", "bad_request"],
  ["issue_file_not_regular", "bad_request"],
  ["managed_issue_file_private", "bad_request"],
  ["issue_file_directory_too_large", "payload_too_large"],
]);

export function domainError(code: string, options?: ErrorOptions): DomainError {
  return new DomainError(code, categories.get(code) ?? "internal", options);
}
