import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

import { MAX_BROWSER_ACTIONS, MAX_ES_RESULTS, MAX_REDIS_KEYS, MAX_REDIS_RESULTS, MAX_SLS_RESULTS } from "./limits.ts";

export const capabilityInputSchemas = {
  nacos: Type.Object({}, { additionalProperties: false }),
  db: Type.Object({ statement: Type.String({ maxLength: 20_000 }) }, { additionalProperties: false }),
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
