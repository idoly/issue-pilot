import { DrizzleQueryError } from "drizzle-orm";

/** Drizzle errors embed SQL parameters, including private configuration values. */
export function errorDiagnostic(error: unknown): unknown {
  const pending = [error], seen = new Set<unknown>();
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
  return error;
}
