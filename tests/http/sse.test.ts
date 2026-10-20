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

test("queues SSE payloads in order until a blocked response drains", () => {
  const response = new FakeResponse();
  response.blockNextWrite = true;
  const writer = createOrderedSseWriter(response);
  const replay = `data: ${"x".repeat(1024 * 1024)}\n\n`;

  writer.write(replay);
  writer.write("event: snapshot_ready\ndata: {}\n\n");
  writer.write("data: live\n\n");
  assert.deepEqual(response.payloads, [replay]);

  response.emit("drain");
  assert.deepEqual(response.payloads, [replay, "event: snapshot_ready\ndata: {}\n\n", "data: live\n\n"]);
});

test("preserves queued and reentrant frames across repeated backpressure", () => {
  const response = new FakeResponse();
  response.blockNextWrite = true;
  const writer = createOrderedSseWriter(response);
  writer.write("first");
  writer.write("second");
  writer.write("third");
  response.blockNextWrite = true;
  response.emit("drain");
  assert.deepEqual(response.payloads, ["first", "second"]);
  const originalWrite = response.write.bind(response);
  response.write = (payload) => {
    if (payload === "third") writer.write("reentrant");
    return originalWrite(payload);
  };
  writer.write("fourth");
  response.emit("drain");
  writer.write("last");
  assert.deepEqual(response.payloads, ["first", "second", "third", "fourth", "reentrant", "last"]);
});

test("treats synchronous socket write failures as a closed stream", () => {
  const response = new FakeResponse();
  let attempts = 0;
  response.write = () => {
    attempts += 1;
    throw new Error("socket_closed");
  };
  const failures: unknown[] = [];
  const writer = createOrderedSseWriter(response, (error) => {
    failures.push(error);
    throw new Error("cleanup_failed");
  });
  writer.write("data: first\n\n");
  assert.equal(attempts, 1);
  assert.match(String(failures[0]), /socket_closed/);
  writer.write("data: must-not-write\n\n");
  assert.equal(attempts, 1);
  assert.equal(failures.length, 1);
});

test("captures transport errors while the stream is idle", () => {
  const response = new FakeResponse();
  const failures: unknown[] = [];
  const writer = createOrderedSseWriter(response, (error) => failures.push(error));

  response.emit("error", new Error("idle_transport_failed"));
  writer.write("data: must-not-write\n\n");

  assert.deepEqual(response.payloads, []);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /idle_transport_failed/);
  assert.equal(response.listenerCount("error"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

test("stops a backpressured stream on transport error before socket flags update", () => {
  const response = new FakeResponse();
  response.blockNextWrite = true;
  const failures: unknown[] = [];
  const writer = createOrderedSseWriter(response, (error) => failures.push(error));
  writer.write("data: first\n\n");
  writer.write("data: must-not-write\n\n");
  response.emit("error", new Error("transport_failed"));
  assert.deepEqual(response.payloads, ["data: first\n\n"]);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /transport_failed/);
  for (const event of ["drain", "close", "error"]) assert.equal(response.listenerCount(event), 0, event);
});

test("releases SSE backpressure waits when the client disconnects", () => {
  const response = new FakeResponse();
  response.blockNextWrite = true;
  const writer = createOrderedSseWriter(response);

  writer.write("data: first\n\n");
  writer.write("data: must-not-write\n\n");
  response.destroyed = true;
  response.emit("close");
  response.emit("drain");
  writer.write("data: must-not-write-after-close\n\n");

  assert.deepEqual(response.payloads, ["data: first\n\n"]);
  for (const event of ["drain", "close", "error"]) assert.equal(response.listenerCount(event), 0, event);
});
