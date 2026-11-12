export type MutationOutcome = "not_committed" | "committed" | "unknown";

/** The medium owner states its commit outcome; HTTP must not infer it from nested error text. */
export class OperationError extends Error {
  readonly outcome: MutationOutcome;

  constructor(code: string, outcome: MutationOutcome, options?: ErrorOptions) {
    super(code, options);
    this.outcome = outcome;
  }
}
