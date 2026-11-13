import { DrizzleQueryError } from "drizzle-orm";

/** Every error reachable through `cause` and AggregateError members, without revisiting an object. */
export function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const pending = [error],
    seen = new Set<unknown>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);
    if (current instanceof AggregateError) pending.push(...current.errors);
    if (typeof current === "object" && "cause" in current) pending.push(current.cause);
  }
  return chain;
}

function codeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Filesystem and process failures are diagnosed by errno; their message embeds absolute paths that must not be logged. */
export function errorCode(error: unknown): string {
  for (const candidate of errorChain(error)) {
    const code = codeOf(candidate);
    if (code) return code;
  }
  return "unknown";
}

/**
 * Sanitize an error for logging. Drizzle errors embed SQL parameters, including private configuration
 * values, and pino flattens `cause` chains, so neither the query nor a raw cause may reach logs.
 */
export function errorDiagnostic(error: unknown): unknown {
  const queryError = errorChain(error).find((candidate): candidate is DrizzleQueryError => candidate instanceof DrizzleQueryError);
  if (queryError) {
    const code = codeOf(queryError.cause);
    return new Error(typeof code === "string" && /^SQLITE_[A-Z_]+$/.test(code) ? `database_operation_failed:${code}` : "database_operation_failed");
  }
  if (error instanceof Error && "cause" in error) return new Error(error.message);
  return error;
}

/** Only stable snake_case codes may be echoed to clients or stored as public reasons. */
export function isStableErrorCode(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(value);
}

/**
 * Match a stable code exactly, or its `code:detail` form, across the whole error chain.
 * Substring matching would let one code satisfy another or an unrelated diagnostic.
 */
export function hasErrorCode(error: unknown, code: string): boolean {
  return errorChain(error).some((candidate) => {
    const message = candidate instanceof Error ? candidate.message : typeof candidate === "string" ? candidate : "";
    // SQLite triggers surface as "SQLITE_CONSTRAINT: trigger_code"; accept only that suffix form.
    const lastSegment = message.slice(message.lastIndexOf(": ") + 2);
    return message === code || message.startsWith(`${code}:`) || lastSegment === code;
  });
}

/** Persisted and projected reasons must not carry paths, command lines or SQL parameters. */
export function stableErrorReason(error: unknown, fallback: string): string {
  // A wrapper's own stable code names the actual condition; only a message that cannot be published
  // falls back to the sanitized diagnostic (which may be a database marker).
  if (error instanceof Error && isStableErrorCode(error.message)) return error.message;
  const diagnostic = errorDiagnostic(error);
  const message = diagnostic instanceof Error ? diagnostic.message : String(diagnostic);
  return isStableErrorCode(message) ? message : fallback;
}
