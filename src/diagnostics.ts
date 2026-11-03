import { DrizzleQueryError } from "drizzle-orm";

/**
 * Sanitize an error for logging. Drizzle errors embed SQL parameters, including private configuration
 * values, and pino flattens `cause` chains, so neither the query nor a raw cause may reach logs.
 */
export function errorDiagnostic(error: unknown): unknown {
  const pending = [error],
    seen = new Set<unknown>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof DrizzleQueryError) {
      const code = current.cause && typeof current.cause === "object" && "code" in current.cause ? current.cause.code : undefined;
      return new Error(typeof code === "string" && /^SQLITE_[A-Z_]+$/.test(code) ? `database_operation_failed:${code}` : "database_operation_failed");
    }
    if (current instanceof AggregateError) pending.push(...current.errors);
    if (typeof current === "object" && "cause" in current) pending.push(current.cause);
  }
  if (error instanceof Error && "cause" in error) return new Error(error.message);
  return error;
}
