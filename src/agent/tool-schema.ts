import type { Schema } from "@earendil-works/pi-schema";

/**
 * Tool parameters must stay a JSON Schema object at the root. A JSON Schema union serializes to a bare
 * `anyOf`, which OpenAI-compatible providers such as DeepSeek reject as `type: null`; adding the
 * object type keeps the union variants and the same validation result.
 */
export function objectToolParameters(schema: Schema): Schema {
  return Array.isArray(schema.anyOf) ? { ...schema, type: "object" } : schema;
}
