import { DrizzleQueryError } from "drizzle-orm";
import { getSystemErrorMap } from "node:util";

import { DomainError, OPERATIONAL_FAILURE_CODES } from "./domain/errors.ts";
import { OperationError } from "./operation-error.ts";

/** Every causal, aggregated or suppressed failure, without revisiting an object. */
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
    if (current instanceof SuppressedError) pending.push(current.suppressed, current.error);
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

const causeCodeLimit = 16;
const systemErrorCodes = new Set([...getSystemErrorMap().values()].map(([code]) => code));

/** Only application-owned failures and known OS codes are safe; message spelling is not a trust boundary. */
function causeCodes(error: unknown, outer: string): string[] {
  const codes = new Set<string>();
  for (const candidate of errorChain(error)) {
    const code = codeOf(candidate);
    if (code && code !== outer && systemErrorCodes.has(code)) codes.add(code);
    if (candidate instanceof DomainError || candidate instanceof OperationError) {
      const owned = candidate instanceof DomainError ? candidate.code : candidate.message;
      if (owned !== outer && owned.length <= 120 && isStableErrorCode(owned)) codes.add(owned);
    }
    if (candidate instanceof DrizzleQueryError) {
      const sqlite = codeOf(candidate.cause);
      if (sqlite && /^SQLITE_[A-Z_]+$/.test(sqlite)) codes.add(sqlite);
    }
    if (codes.size >= causeCodeLimit) break;
  }
  return [...codes];
}

function withCauses(message: string, error: unknown): Error {
  const diagnostic = new Error(message);
  const causes = causeCodes(error, message);
  // pino serializes enumerable error properties; only the filtered codes are attached.
  if (causes.length) Object.assign(diagnostic, { causes });
  return diagnostic;
}

/**
 * Sanitize an error for logging. Drizzle errors embed SQL parameters, including private configuration
 * values, and pino serializes causes and aggregate members, so only the public wrapper is logged, together
 * with the safe structured codes of its causes.
 */
export function errorDiagnostic(error: unknown): unknown {
  const queryError = errorChain(error).find((candidate): candidate is DrizzleQueryError => candidate instanceof DrizzleQueryError);
  if (queryError) {
    const code = codeOf(queryError.cause);
    return withCauses(typeof code === "string" && /^SQLITE_[A-Z_]+$/.test(code) ? `database_operation_failed:${code}` : "database_operation_failed", error);
  }
  if (error instanceof Error && ("cause" in error || error instanceof AggregateError || error instanceof SuppressedError)) return withCauses(error.message, error);
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
    return message === code || message.startsWith(`${code}:`) || message === `SQLITE_CONSTRAINT: ${code}`;
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

/**
 * Failures whose owner already declared a category or outcome, or that need operator inspection.
 * Structured codes (including filesystem errno) also belong to the originating owner.
 * A boundary may replace only unclassified failures with its own stable code; classified ones keep
 * their category, outcome and cause.
 */
export function isClassifiedOwnerFailure(error: unknown): boolean {
  return (
    error instanceof DomainError ||
    errorChain(error).some((cause) => cause instanceof OperationError || codeOf(cause) !== undefined) ||
    [...OPERATIONAL_FAILURE_CODES].some((code) => hasErrorCode(error, code))
  );
}
