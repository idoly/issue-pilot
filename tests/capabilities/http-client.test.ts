import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedResponseText, responseJson } from "../../src/capabilities/http-client.ts";

test("reads UTF-8 across byte-view boundaries and releases the completed body", async () => {
  const expected = "订单🙂\n", bytes = new TextEncoder().encode(expected);
  const backing = new Uint8Array(bytes.length + 4).fill(127); backing.set(bytes, 2);
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(backing.subarray(2, 3));
    controller.enqueue(backing.subarray(3, 8));
    controller.enqueue(backing.subarray(8, bytes.length + 2));
    controller.close();
  } }));
  assert.equal(await boundedResponseText(response, bytes.length), expected);
  assert.equal(response.body!.locked, false);
  assert.equal(await boundedResponseText(new Response(null)), "");
});

test("stops at the byte limit and preserves the budget error if cancellation fails", async () => {
  let reads = 0, cancellations = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array([1, 2])); },
    cancel() { cancellations++; throw new Error("fixture_cancel_failed"); },
  }, { highWaterMark: 0 }), { headers: { "content-length": "1" } });
  await assert.rejects(boundedResponseText(response, 3), { message: "capability_result_too_large" });
  assert.equal(reads, 2);
  assert.equal(cancellations, 1);
  assert.equal(response.body!.locked, false);
});

test("preserves a stream read error and releases the failed body", async () => {
  const reason = new Error("fixture_read_failed");
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.error(reason); } }));
  await assert.rejects(boundedResponseText(response), error => error === reason);
  assert.equal(response.body!.locked, false);
});

test("keeps HTTP error normalization and empty JSON responses", async () => {
  const response = new Response("private upstream diagnostic", { status: 502 });
  await assert.rejects(responseJson(response), { message: "external_http_502" });
  assert.equal(response.body!.locked, false);
  assert.equal(await responseJson(new Response(null)), null);
});
