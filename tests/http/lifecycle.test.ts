import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import type { FastifyInstance } from "fastify";

import { installShutdownHandlers } from "../../src/http/lifecycle.ts";

test("closes Fastify exactly once when the process receives a shutdown signal", async () => {
  const target = new EventEmitter();
  let closes = 0;
  const app = {
    async close() { closes += 1; },
    log: { error() {} },
  } as unknown as FastifyInstance;
  const remove = installShutdownHandlers(app, target as never);
  target.emit("SIGTERM");
  target.emit("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
  remove();
  assert.equal(target.listenerCount("SIGTERM"), 0);
  assert.equal(target.listenerCount("SIGINT"), 0);
});
