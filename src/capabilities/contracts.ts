import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const MAX_BROWSER_ACTIONS = 50;
export const MAX_CAPABILITY_RESULT_BYTES = 1024 * 1024;
export const MAX_CAPABILITY_TIMEOUT_MS = 15_000;
export const MAX_DATABASE_QUERY_CHARS = 20_000;
export const MAX_DATABASE_ROWS = 500;
export const MAX_ES_RESULTS = 200;
export const MAX_NACOS_DATA_IDS = 50;
export const MAX_REDIS_KEYS = 100;
export const MAX_REDIS_RESULTS = 500;
export const MAX_SLS_RESULTS = 200;

export function capabilityResultText(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) > MAX_CAPABILITY_RESULT_BYTES) throw new Error("capability_result_too_large");
  return text;
}

export function capabilitySignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(MAX_CAPABILITY_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function capabilityTextResult<Details extends Record<string, unknown>>(text: string, details: Details) {
  return { content: [{ type: "text" as const, text }], details };
}

export const isNacosTarget = (value: string): boolean => /^[a-zA-Z0-9._-]{1,255}$/.test(value);
export const isSlsLogstore = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,61}[a-zA-Z0-9]$/.test(value);

export const capabilityInputSchemas = {
  nacos: Type.Object({}, { additionalProperties: false }),
  db: Type.Object({ statement: Type.String({ maxLength: MAX_DATABASE_QUERY_CHARS }) }, { additionalProperties: false }),
  sls: Type.Object({
    logstore: Type.String({ maxLength: 63 }),
    from: Type.Optional(Type.Integer({ minimum: 0 })),
    to: Type.Optional(Type.Integer({ minimum: 1 })),
    query: Type.Optional(Type.String({ maxLength: 4096 })),
    trace_id: Type.Optional(Type.String({ maxLength: 36 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SLS_RESULTS })),
  }, { additionalProperties: false }),
  redis: Type.Object({
    action: StringEnum(["get", "mget", "hget", "hgetall", "type", "ttl", "scan"] as const),
    key: Type.Optional(Type.String({ maxLength: 1024 })),
    keys: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: MAX_REDIS_KEYS })),
    field: Type.Optional(Type.String({ maxLength: 1024 })),
    pattern: Type.Optional(Type.String({ maxLength: 1024 })),
    cursor: Type.Optional(Type.String({ maxLength: 30 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_REDIS_RESULTS })),
  }, { additionalProperties: false }),
  es: Type.Object({
    action: StringEnum(["search", "count", "mapping"] as const),
    query: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ES_RESULTS })),
  }, { additionalProperties: false }),
  mq: Type.Object({
    action: StringEnum(["overview", "queues", "queue", "bindings"] as const),
    queue: Type.Optional(Type.String({ maxLength: 255 })),
  }, { additionalProperties: false }),
  playwright: Type.Object({
    actions: Type.Array(Type.Union([
      Type.Object({ type: Type.Literal("goto"), path: Type.String({ maxLength: 2048 }) }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal("login"), username_selector: Type.String({ maxLength: 500 }), password_selector: Type.String({ maxLength: 500 }), submit_selector: Type.String({ maxLength: 500 }) }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal("click"), selector: Type.String({ maxLength: 500 }) }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal("fill"), selector: Type.String({ maxLength: 500 }), value: Type.String({ maxLength: 10_000 }) }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal("select"), selector: Type.String({ maxLength: 500 }), value: Type.String({ maxLength: 10_000 }) }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal("wait_for"), selector: Type.String({ maxLength: 500 }) }, { additionalProperties: false }),
    ]), { minItems: 1, maxItems: MAX_BROWSER_ACTIONS }),
    screenshot: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
} as const;

export type CapabilityInputs = {
  [Key in keyof typeof capabilityInputSchemas]: Static<(typeof capabilityInputSchemas)[Key]>;
};
