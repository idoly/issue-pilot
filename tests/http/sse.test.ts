import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createOrderedSseWriter } from "../../src/http/sse.ts";

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly payloads: string[] = [];
  blockNextWrite = false;

  write(payload: string): boolean {
    this.payloads.push(payload);
    if (!this.blockNextWrite) return true;
    this.blockNextWrite = false;
    return false;
  }
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("queues SSE payloads in order until a blocked response drains", async () => {
  const response = new FakeResponse();
  response.blockNextWrite = true;
  const writer = createOrderedSseWriter(response);
  const replay = `data: ${"x".repeat(1024 * 1024)}\n\n`;

  writer.write(replay);
  writer.write("event: ready\ndata: {}\n\n");
  writer.write("data: live\n\n");
  await nextTurn();
  assert.deepEqual(response.payloads, [replay]);

  response.emit("drain");
  await writer.idle();
  assert.deepEqual(response.payloads, [replay, "event: ready\ndata: {}\n\n", "data: live\n\n"]);
});

test("releases SSE backpressure waits when the client disconnects", async () => {
  const response = new FakeResponse();
  response.blockNextWrite = true;
  const writer = createOrderedSseWriter(response);

  writer.write("data: first\n\n");
  writer.write("data: must-not-write\n\n");
  await nextTurn();
  response.destroyed = true;
  response.emit("close");
  await writer.idle();

  assert.deepEqual(response.payloads, ["data: first\n\n"]);
});
