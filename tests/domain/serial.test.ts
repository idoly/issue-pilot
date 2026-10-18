import assert from "node:assert/strict";
import { test } from "node:test";

import { KeyedSerialQueue, SerialQueue } from "../../src/serial.ts";

test("SerialQueue preserves order, recovers from failures, and exposes idle state", async () => {
  const queue = new SerialQueue();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = queue.run(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
    throw new Error("expected_failure");
  });
  const second = queue.run(async () => { events.push("second"); return 2; });
  let idle = false;
  const waiting = queue.idle().then(() => { idle = true; });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  assert.equal(idle, false);
  releaseFirst();
  await assert.rejects(first, /expected_failure/);
  assert.equal(await second, 2);
  await waiting;
  assert.deepEqual(events, ["first:start", "first:end", "second"]);
  assert.equal(idle, true);
});

test("KeyedSerialQueue serializes each key while allowing different keys to progress", async () => {
  const queue = new KeyedSerialQueue();
  const events: string[] = [];
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });

  const firstA = queue.run("a", async () => {
    events.push("a:first:start");
    await gateA;
    events.push("a:first:end");
  });
  const secondA = queue.run("a", async () => { events.push("a:second"); });
  const firstB = queue.run("b", async () => { events.push("b:first"); });
  let idle = false;
  const waiting = queue.idle().then(() => { idle = true; });

  await firstB;
  assert.deepEqual(events, ["a:first:start", "b:first"]);
  assert.equal(idle, false);
  releaseA();
  await Promise.all([firstA, secondA, waiting]);
  assert.deepEqual(events, ["a:first:start", "b:first", "a:first:end", "a:second"]);
  assert.equal(idle, true);

  await assert.rejects(queue.run("a", async () => { throw new Error("expected_failure"); }), /expected_failure/);
  assert.equal(await queue.run("a", async () => 3), 3);
});

test("queues recover from synchronous throws and preserve FIFO when running work enqueues more work", async () => {
  for (const queue of [new SerialQueue(), new KeyedSerialQueue()]) {
    const run = (operation: () => Promise<number>) => queue instanceof KeyedSerialQueue ? queue.run("same", operation) : queue.run(operation);
    await assert.rejects(run(() => { throw new Error("synchronous_failure"); }), /synchronous_failure/);
    const events: string[] = [];
    let third: Promise<number> | undefined;
    const first = run(async () => {
      events.push("first");
      third = run(async () => { events.push("third"); return 3; });
      return 1;
    });
    const second = run(async () => { events.push("second"); return 2; });
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.ok(third);
    assert.equal(await third, 3);
    await queue.idle();
    assert.deepEqual(events, ["first", "second", "third"]);
  }
});
