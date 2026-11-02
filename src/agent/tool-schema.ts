import type { TSchema } from "typebox";

/**
 * Tool parameters must stay a JSON Schema object at the root. A TypeBox union serializes to a bare
 * `anyOf`, which OpenAI-compatible providers such as DeepSeek reject as `type: null`; adding the
 * object type keeps the union variants and the same validation result.
 */
export function objectToolParameters(schema: TSchema): TSchema {
  const union = schema as unknown as { anyOf?: TSchema[] };
  return Array.isArray(union.anyOf) ? { ...union, type: "object" } as TSchema : schema;
}
