import { parseIssueKey } from "../domain/contracts.ts";
import { OperationError } from "../operation-error.ts";

type PostCreateFailure = "issue_created_enqueue_unconfirmed" | "issue_created_summary_unavailable";

export class IssueCreatedError extends OperationError {
  readonly issueKey: string;
  constructor(code: PostCreateFailure, issueKey: string, options?: ErrorOptions) {
    super(code, "committed", options);
    this.issueKey = issueKey;
  }
  receipt() {
    return { error: this.message, outcome: this.outcome, issueKey: this.issueKey };
  }
}

/** Trust only the closed post-create protocol; arbitrary error text cannot supply a navigation target. */
export function readCreationReceipt(value: unknown): IssueCreatedError | undefined {
  if (!value || typeof value !== "object" || !("outcome" in value) || value.outcome !== "committed" || !("issueKey" in value) || typeof value.issueKey !== "string" || !("error" in value)) return;
  if (value.error !== "issue_created_enqueue_unconfirmed" && value.error !== "issue_created_summary_unavailable") return;
  const key = parseIssueKey(value.issueKey);
  if (key) return new IssueCreatedError(value.error, key);
}
