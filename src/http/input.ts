export class ApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_request");
  return value as Record<string, unknown>;
}

export function text(value: unknown, name: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new ApiError(400, `invalid_${name}`);
  return value.trim();
}

export function optionalText(value: unknown, maximum = 10_000): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > maximum) throw new ApiError(400, "invalid_text");
  return value.trim();
}

export function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) throw new ApiError(400, `invalid_${name}`);
  return value as string[];
}

export function choice<const Values extends readonly string[]>(value: unknown, name: string, values: Values): Values[number] {
  const selected = text(value, name, 100);
  if (!values.includes(selected)) throw new ApiError(400, `invalid_${name}`);
  return selected as Values[number];
}
