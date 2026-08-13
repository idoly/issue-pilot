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

test("treats synchronous socket write failures as a closed stream", async () => {
  const response = new FakeResponse();
  let attempts = 0;
  response.write = () => {
    attempts += 1;
    throw new Error("socket_closed");
  };
  const failures: unknown[] = [];
  const writer = createOrderedSseWriter(response, Number.POSITIVE_INFINITY, (error) => {
    failures.push(error);
    throw new Error("cleanup_failed");
  });
  writer.write("data: first\n\n");
  await writer.idle();
  assert.equal(attempts, 1);
  assert.match(String(failures[0]), /socket_closed/);
  writer.write("data: must-not-write\n\n");
  await writer.idle();
  assert.equal(attempts, 1);
  assert.equal(failures.length, 1);
});

test("captures transport errors while the stream is idle", async () => {
  const response = new FakeResponse();
  const failures: unknown[] = [];
  const writer = createOrderedSseWriter(response, Number.POSITIVE_INFINITY, (error) => failures.push(error));

  response.emit("error", new Error("idle_transport_failed"));
  await writer.idle();
  writer.write("data: must-not-write\n\n");

  assert.deepEqual(response.payloads, []);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /idle_transport_failed/);
  assert.equal(response.listenerCount("error"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

test("stops a backpressured stream on transport error before socket flags update", async () => {
  const response = new FakeResponse();
  response.blockNextWrite = true;
  const failures: unknown[] = [];
  const writer = createOrderedSseWriter(response, Number.POSITIVE_INFINITY, (error) => failures.push(error));
  writer.write("data: first\n\n");
  writer.write("data: must-not-write\n\n");
  await nextTurn();
  response.emit("error", new Error("transport_failed"));
  await writer.idle();
  assert.deepEqual(response.payloads, ["data: first\n\n"]);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /transport_failed/);
});

test("closes a slow stream before its pending payload budget is exceeded", async () => {
  const response = new FakeResponse();
  response.blockNextWrite = true;
  const failures: unknown[] = [];
  const writer = createOrderedSseWriter(response, 10, (error) => failures.push(error));
  writer.write("12345678");
  await nextTurn();
  writer.write("abc");
  writer.write("must-not-write");
  await writer.idle();
  assert.deepEqual(response.payloads, ["12345678"]);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /sse_backpressure_limit_exceeded/);
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
