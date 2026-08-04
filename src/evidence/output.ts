const SENSITIVE_FIELD = /(access.?key|secret|password|passwd|token|authorization|cookie|connection.?string)/i;

export function sensitive(name: string): boolean {
  return SENSITIVE_FIELD.test(name);
}

export function redact(value: string): string {
  return value
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/((?:password|passwd|secret|token|authorization|cookie|access[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:password|passwd|secret|token|access[_-]?key)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[REDACTED]@");
}

function bounded(value: unknown, redactSensitive: boolean): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => bounded(entry, redactSensitive));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, entry]) => [
      key,
      redactSensitive && sensitive(key) ? "[REDACTED]" : bounded(entry, redactSensitive),
    ]));
  }
  if (typeof value !== "string") return value;
  return (redactSensitive ? redact(value) : value).slice(0, 2000);
}

export function sanitize(value: unknown): unknown {
  return bounded(value, true);
}

export function result(value: unknown, details: Record<string, unknown>, options: { redact?: boolean } = {}) {
  const serialized = JSON.stringify(bounded(value, options.redact !== false), null, 2);
  const truncated = Buffer.byteLength(serialized, "utf8") > 50 * 1024;
  const text = truncated ? `${Buffer.from(serialized).subarray(0, 48 * 1024).toString("utf8")}\n[TRUNCATED]` : serialized;
  return { content: [{ type: "text" as const, text }], details: truncated ? { ...details, outputTruncated: true } : details };
}
