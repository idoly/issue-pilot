import {createApiFixture, createService, createIssue} from '../../tests/http/fixture.ts';
import {AgentEventBus} from '../../src/agent/events.ts';

if (!global.gc) throw new Error('Run with --expose-gc and --experimental-strip-types');
const count = Number(process.argv[2] ?? 100_000);
if (!Number.isSafeInteger(count) || count < 1) throw new Error('event_count_must_be_a_positive_integer');
const events = new AgentEventBus();
const fixture = await createApiFixture({events});
const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
let consuming;
try {
  await createService(fixture.app, 'MemoryFixture');
  const issue = await createIssue(fixture.app, 'memoryfixture');
  const issueId = fixture.engine.enqueued[0];
  const address = await fixture.app.listen({host: '127.0.0.1', port: 0});
  const response = await fetch(`${address}/api/issues/${issue.id}/agent-stream`, {signal});
  if (!response.ok || !response.body) throw new Error('agent_stream_unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  let bytes = 0;
  let ready;
  let finished;
  const snapshot = new Promise(resolve => { ready = resolve; });
  const drained = new Promise(resolve => { finished = resolve; });
  consuming = (async () => {
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        tail = (tail + decoder.decode(value, {stream: true})).slice(-4096);
        if (tail.includes('event: snapshot_ready')) ready();
        if (tail.includes('bench-finished')) finished();
      }
    } finally { reader.releaseLock(); }
  })();
  const unexpectedEnd = consuming.then(() => { throw new Error('agent_stream_ended_before_completion'); });
  await Promise.race([snapshot, unexpectedEnd]);
  for (let index = 0; index < 3; index++) { global.gc(); await new Promise(resolve => setImmediate(resolve)); }
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
  for (let index = 0; index < count; index++) {
    events.publish({id: 'bench-live-' + String(index).padStart(36, '0'), issueId, createdAt: '2026-10-23T00:00:00.000Z', event: {type: 'message_update', usage, assistantMessageEvent: {type: 'text_delta', contentIndex: 0, delta: 'x'}}});
    if (index % 100 === 99) { signal.throwIfAborted(); await new Promise(resolve => setImmediate(resolve)); }
  }
  events.publish({id: 'bench-finished', issueId, createdAt: '2026-10-23T00:00:00.000Z', event: {type: 'issue_status', status: 'complete'}});
  await Promise.race([drained, unexpectedEnd]);
  for (let index = 0; index < 3; index++) { await new Promise(resolve => setImmediate(resolve)); global.gc(); }
  const after = process.memoryUsage().heapUsed;
  console.log(JSON.stringify({count, bytes, heapBefore: before, heapAfter: after, retainedHeapBytes: after - before, elapsedMs: performance.now() - started}));
} finally {
  controller.abort();
  await consuming?.catch(() => {});
  await fixture.cleanup();
}
