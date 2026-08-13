import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

import { issuePilotConfig } from "../../issue-pilot.config.ts";

const limits = issuePilotConfig.limits.capability;

export function capabilityResultText(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) > limits.resultBytes) throw new Error("capability_result_too_large");
  return text;
}

export function capabilitySignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function capabilityTextResult<Details extends Record<string, unknown>>(text: string, details: Details) {
  return { content: [{ type: "text" as const, text }], details };
}

export const isNacosTarget = (value: string): boolean => /^[a-zA-Z0-9._-]{1,255}$/.test(value);
export const isSlsLogstore = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,61}[a-zA-Z0-9]$/.test(value);

export const capabilityInputSchemas = {
  nacos: Type.Object({}, { additionalProperties: false }),
  db: Type.Object({ statement: Type.String({ maxLength: limits.database.queryChars }) }, { additionalProperties: false }),
  dms: Type.Object({ statement: Type.String({ maxLength: limits.dms.queryChars }) }, { additionalProperties: false }),
  sls: Type.Object({
    logstore: Type.String({ maxLength: 63 }),
    from: Type.Optional(Type.Integer({ minimum: 0 })),
    to: Type.Optional(Type.Integer({ minimum: 1 })),
    query: Type.Optional(Type.String({ maxLength: limits.sls.queryChars })),
    trace_id: Type.Optional(Type.String({ maxLength: limits.sls.traceIdChars })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: limits.sls.results })),
  }, { additionalProperties: false }),
  redis: Type.Object({
    action: StringEnum(["get", "mget", "hget", "hgetall", "type", "ttl", "scan"] as const),
    key: Type.Optional(Type.String({ maxLength: limits.redis.keyChars })),
    keys: Type.Optional(Type.Array(Type.String({ maxLength: limits.redis.keyChars }), { maxItems: limits.redis.keys })),
    field: Type.Optional(Type.String({ maxLength: limits.redis.keyChars })),
    pattern: Type.Optional(Type.String({ maxLength: limits.redis.keyChars })),
    cursor: Type.Optional(Type.String({ maxLength: limits.redis.cursorChars })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: limits.redis.results })),
  }, { additionalProperties: false }),
  es: Type.Object({
    action: StringEnum(["search", "count", "mapping"] as const),
    query: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: limits.elasticsearch.results })),
  }, { additionalProperties: false }),
  mq: Type.Object({
    action: StringEnum(["overview", "queues", "queue", "bindings"] as const),
    queue: Type.Optional(Type.String({ maxLength: limits.rabbitmq.queueChars })),
  }, { additionalProperties: false }),
  playwright: Type.Object({
    actions: Type.Array(Type.Union([
      Type.Object({ type: Type.Literal("goto"), path: Type.String({ maxLength: limits.browser.pathChars }) }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal("login"), username_selector: Type.String({ maxLength: limits.browser.selectorChars }), password_selector: Type.String({ maxLength: limits.browser.selectorChars }), submit_selector: Type.String({ maxLength: limits.browser.selectorChars }) }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal("click"), selector: Type.String({ maxLength: limits.browser.selectorChars }) }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal("fill"), selector: Type.String({ maxLength: limits.browser.selectorChars }), value: Type.String({ maxLength: limits.browser.valueChars }) }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal("select"), selector: Type.String({ maxLength: limits.browser.selectorChars }), value: Type.String({ maxLength: limits.browser.valueChars }) }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal("wait_for"), selector: Type.String({ maxLength: limits.browser.selectorChars }) }, { additionalProperties: false }),
    ]), { minItems: 1, maxItems: limits.browser.actions }),
    screenshot: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
} as const;

export type CapabilityInputs = {
  [Key in keyof typeof capabilityInputSchemas]: Static<(typeof capabilityInputSchemas)[Key]>;
};
