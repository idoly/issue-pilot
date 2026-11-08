import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createOrderedSseWriter } from "../../src/http/sse.ts";

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly payloads: string[] = [];
  readonly completions: ((error?: Error | null) => void)[] = [];
  blockNextWrite = false;

  write(payload: string, onComplete: (error?: Error | null) => void = () => undefined): boolean {
    this.payloads.push(payload);
    this.completions.push(onComplete);
    if (!this.blockNextWrite) return true;
    this.blockNextWrite = false;
    return false;
  }
}

for (const drainFirst of [false, true])
  test(`completes paced replay after a flushed write ${drainFirst ? "with" : "without"} a drain event`, { timeout: 1_000 }, async () => {
    const response = new FakeResponse();
    const writer = createOrderedSseWriter(response);
    response.blockNextWrite = true;
    writer.write("data: replay\n\n");
    const replay = writer.drain();
    if (drainFirst) response.emit("drain");
    else response.completions[0]!();
    await replay;

    response.blockNextWrite = true;
    writer.write("event: snapshot_ready\ndata: {}\n\n");
    writer.write("event: heartbeat\ndata: {}\n\n");
    let finished = false;
    const pending = writer.drain().then(() => {
      finished = true;
    });
    // A late callback from the previous frame must not release the current write.
    response.completions[0]!();
    await Promise.resolve();
    assert.equal(finished, false);
    assert.equal(response.payloads.length, 2);
    response.completions[1]!();
    await pending;
    assert.deepEqual(response.payloads, ["data: replay\n\n", "event: snapshot_ready\ndata: {}\n\n", "event: heartbeat\ndata: {}\n\n"]);
    assert.equal(response.listenerCount("drain"), 0);
    response.emit("close");
  });

test("does not wait for a drain after synchronous write completion", { timeout: 1_000 }, async () => {
  const response = new FakeResponse();
  response.write = (payload, onComplete) => {
    response.payloads.push(payload);
    onComplete?.();
    return false;
  };
  const writer = createOrderedSseWriter(response);
  writer.write("data: replay\n\n");
  await writer.drain();
  writer.write("event: snapshot_ready\ndata: {}\n\n");
  await writer.drain();
  assert.equal(response.payloads.length, 2);
  assert.equal(response.listenerCount("drain"), 0);
  response.emit("close");
});

test("releases paced replay on write callback failure and ignores late completions", { timeout: 1_000 }, async () => {
  const response = new FakeResponse();
  const failures: unknown[] = [];
  const writer = createOrderedSseWriter(response, (error) => failures.push(error));
  writer.write("data: accepted\n\n");
  response.blockNextWrite = true;
  writer.write("data: blocked\n\n");
  writer.write("data: must-not-write\n\n");
  const pending = writer.drain();
  response.completions[0]!(new Error("write_failed"));
  await pending;
  response.completions[1]!();
  writer.write("data: must-not-write-after-failure\n\n");
  assert.equal(response.payloads.length, 2);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /write_failed/);
  for (const event of ["drain", "close", "error"]) assert.equal(response.listenerCount(event), 0, event);
});

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

test("bounds queued UTF-8 bytes and releases waits after a slow client exceeds the budget", async () => {
  const response = new FakeResponse();
  response.blockNextWrite = true;
  const failures: unknown[] = [];
  const writer = createOrderedSseWriter(response, (error) => failures.push(error), 6);
  writer.write("first");
  const drained = writer.drain();
  writer.write("中文"); // Six bytes, exactly at the budget.
  assert.equal(failures.length, 0);
  writer.write("x");
  await drained;
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /sse_queue_budget_exceeded/);
  response.emit("drain");
  writer.write("must-not-write");
  assert.deepEqual(response.payloads, ["first"]);
  for (const event of ["drain", "close", "error"]) assert.equal(response.listenerCount(event), 0);
});

test("paced replay can exceed the total queue budget without disconnecting", async () => {
  const response = new FakeResponse();
  const failures: unknown[] = [];
  const writer = createOrderedSseWriter(response, (error) => failures.push(error), 4);
  for (let index = 0; index < 5; index++) {
    response.blockNextWrite = true;
    writer.write(`replay-${index}`); // A single directly written frame need not fit the waiting queue.
    let completed = false;
    const pending = writer.drain().then(() => {
      completed = true;
    });
    await Promise.resolve();
    assert.equal(completed, false);
    response.emit("drain");
    await pending;
  }
  assert.equal(response.payloads.length, 5);
  assert.deepEqual(failures, []);
  await writer.drain();
  response.emit("close");
});

test("queue bytes are reclaimed on drain and a disconnected replay stops waiting", async () => {
  const response = new FakeResponse();
  response.blockNextWrite = true;
  const failures: unknown[] = [];
  const writer = createOrderedSseWriter(response, (error) => failures.push(error), 4);
  writer.write("first");
  writer.write("four");
  response.emit("drain");
  await writer.drain();
  response.blockNextWrite = true;
  writer.write("second");
  writer.write("four");
  const pending = writer.drain();
  response.emit("close");
  await pending;
  assert.deepEqual(response.payloads, ["first", "four", "second"]);
  assert.deepEqual(failures, []);
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
