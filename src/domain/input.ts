import { DomainError } from "./errors.ts";

/**
 * Transport-neutral parsing of untrusted structured input. Failures are bad_request DomainErrors with the
 * caller's public code; HTTP routes and configuration owners share these rules.
 */
function invalid(code: string): DomainError {
  return new DomainError(code, "bad_request");
}

export function checkRevision(value: unknown, actual: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalid("invalid_configuration_revision");
  if (value !== actual) throw new DomainError("configuration_changed", "conflict");
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("invalid_request");
  return value as Record<string, unknown>;
}

/** One boundary rule for closed request bodies; the caller keeps its own public error code. */
export function closedRecord(value: unknown, allowed: readonly string[], code: string): Record<string, unknown> {
  const input = record(value);
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw invalid(code);
  return input;
}

export function text(value: unknown, name: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw invalid(`invalid_${name}`);
  return value.trim();
}

export function optionalText(value: unknown, maximum = 10_000): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > maximum) throw invalid("invalid_text");
  return value.trim() || null;
}

export function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) throw invalid(`invalid_${name}`);
  return value as string[];
}

export function choice<const Values extends readonly string[]>(value: unknown, name: string, values: Values): Values[number] {
  const selected = text(value, name, 100);
  if (!values.includes(selected)) throw invalid(`invalid_${name}`);
  return selected as Values[number];
}
