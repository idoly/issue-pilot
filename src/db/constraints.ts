import { errorChain } from "../diagnostics.ts";
import { DomainError } from "../domain/errors.ts";

/** Codes raised by schema triggers that describe a client-correctable conflict; other trigger codes stay internal. */
const CONFLICT_TRIGGER_CODES: ReadonlySet<string> = new Set(["issue_deployment_required", "deployment_is_used_by_issues", "issue_resolution_state_invalid"]);

function extendedCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = "extendedCode" in error ? error.extendedCode : "code" in error ? error.code : undefined;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT") ? code : undefined;
}

/**
 * The single translation of SQLite constraint failures into conflict DomainErrors. It reads the driver's
 * structured constraint code; only trigger failures read the message, whose last segment is the trigger's code.
 * Drizzle query wrappers are skipped because their message embeds SQL parameters.
 */
export function constraintFailure(error: unknown): DomainError | undefined {
  for (const candidate of errorChain(error)) {
    const code = extendedCode(candidate);
    if (!code) continue;
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") return new DomainError("conflict", "conflict", { cause: error });
    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") return new DomainError("resource_in_use", "conflict", { cause: error });
    if (code === "SQLITE_CONSTRAINT_TRIGGER" && candidate instanceof Error) {
      const trigger = candidate.message.slice(candidate.message.lastIndexOf(": ") + 2);
      if (CONFLICT_TRIGGER_CODES.has(trigger)) return new DomainError(trigger, "conflict", { cause: error });
    }
  }
  return undefined;
}
