import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { test } from "node:test";
import { CodemodeQueue } from "../../src/agent/codemode-extension.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

test("Codemode admission runs scripts in FIFO order and recovers after a failure", async () => {
  const queue = new CodemodeQueue(1_000, 4), first = deferred(), second = deferred(), order: number[] = [];
  const a = queue.run(async () => { order.push(1); await first.promise; });
  const b = queue.run(async () => { order.push(2); await second.promise; throw new Error("script_failed"); });
  const rejected = assert.rejects(b, { message: "script_failed" });
  const c = queue.run(async () => { order.push(3); return "completed"; });
  try {
    await turn(); assert.deepEqual(order, [1]);
    first.resolve(); await a; await turn(); assert.deepEqual(order, [1, 2]);
    second.resolve(); await rejected; assert.equal(await c, "completed");
    assert.deepEqual(order, [1, 2, 3]);
  } finally { first.resolve(); second.resolve(); await Promise.allSettled([a, b, c]); }
});

test("cancels a waiting Codemode script promptly and frees its queue entry", async () => {
  const queue = new CodemodeQueue(1_000, 1), held = deferred(), controller = new AbortController(), reason = new Error("cancelled_while_waiting");
  let ran = false;
  const active = queue.run(() => held.promise);
  const waiting = queue.run(async () => { ran = true; }, controller.signal);
  try {
    controller.abort(reason); await assert.rejects(waiting, error => error === reason);
    assert.equal(ran, false);
    const next = queue.run(async () => "next");
    held.resolve(); await active; assert.equal(await next, "next"); assert.equal(ran, false);
  } finally { held.resolve(); await Promise.allSettled([active, waiting]); }
});

test("times out queued Codemode work without running it later", async () => {
  const queue = new CodemodeQueue(20, 1), held = deferred(); let ran = false;
  const active = queue.run(() => held.promise);
  try {
    await assert.rejects(queue.run(async () => { ran = true; }), { message: "codemode_queue_timeout" });
    assert.equal(ran, false);
    held.resolve(); await active;
    assert.equal(await queue.run(async () => "recovered"), "recovered"); assert.equal(ran, false);
  } finally { held.resolve(); await active; }
});

test("bounds Codemode waiters and leaves accepted jobs intact", async () => {
  const queue = new CodemodeQueue(1_000, 1), held = deferred();
  const active = queue.run(() => held.promise), accepted = queue.run(async () => "accepted");
  try {
    await assert.rejects(queue.run(async () => "overflow"), { message: "codemode_queue_capacity_exceeded" });
    held.resolve(); await active; assert.equal(await accepted, "accepted");
  } finally { held.resolve(); await Promise.allSettled([active, accepted]); }
});

test("keeps the active slot until the tool finishes cancellation cleanup", async () => {
  const queue = new CodemodeQueue(1_000, 2), held = deferred(), controller = new AbortController(); let nextStarted = false;
  const active = queue.run(() => held.promise, controller.signal);
  const next = queue.run(async () => { nextStarted = true; });
  try {
    await turn(); controller.abort(new Error("cancelled_running_tool")); await turn();
    assert.equal(nextStarted, false);
    held.resolve(); await active; await next; assert.equal(nextStarted, true);
  } finally { held.resolve(); await Promise.allSettled([active, next]); }
});

test("rejects pre-cancelled Codemode calls before admission", async () => {
  const queue = new CodemodeQueue(), reason = new Error("cancelled_before_admission"); let ran = false;
  await assert.rejects(queue.run(async () => { ran = true; }, AbortSignal.abort(reason)), error => error === reason);
  assert.equal(ran, false); assert.equal(await queue.run(async () => "ready"), "ready");
});
