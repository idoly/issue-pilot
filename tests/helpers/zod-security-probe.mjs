import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const [root, phase] = process.argv.slice(2);
if (!root || !['before', 'after'].includes(phase)) throw new Error('zod_probe_arguments_required');
const patched = phase === 'after';
const require = createRequire(import.meta.url);
const count = 10_000;
const results = [];
for (const variant of ['v3/index.js', 'v3/index.cjs', 'v4/index.js', 'v4/index.cjs', 'v4-mini/index.js', 'v4-mini/index.cjs']) {
  const file = path.join(root, 'node_modules/zod', variant);
  const z = variant.endsWith('.cjs') ? require(file) : await import(pathToFileURL(file));
  const mini = variant.includes('mini');
  const v3 = variant.startsWith('v3/');
  const capped = mini ? z.array(z.string()).check(z.maxLength(1)) : z.array(z.string()).max(1, 'too many');
  const oversized = capped.safeParse(Array(count).fill(7));
  assert.equal(oversized.success, false);
  assert.equal(oversized.error.issues.length, patched ? 1 : count + 1);
  if (patched) assert.equal(oversized.error.issues[0].code, 'too_big');
  assert.deepEqual(capped.parse(['a']), ['a']);
  assert.equal(capped.safeParse(7).error.issues.some(issue => issue.code === 'invalid_type'), true);
  const nested = z.object({items: capped}).safeParse({items: Array(count).fill(7)});
  assert.equal(nested.error.issues.length, patched ? 1 : count + 1);
  if (patched) assert.deepEqual(nested.error.issues[0].path, ['items']);
  assert.equal(z.array(z.string()).safeParse([7, 7]).error.issues.length, 2, 'unbounded schemas retain their normal behavior');
  if (!mini) {
    assert.equal(oversized.error.issues.find(issue => issue.code === 'too_big').message, 'too many');
    const exact = z.array(z.string()).length(1).safeParse(['a', 'b']);
    assert.equal(exact.success, false);
    assert.equal(exact.error.issues[0].code, 'too_big');
    assert.equal(z.array(z.string()).min(2).safeParse(['a']).error.issues[0].code, 'too_small');
    assert.deepEqual(z.array(z.string().transform(value => value.trim())).max(2).parse([' a ', ' b ']), ['a', 'b']);
    let transformed = 0;
    let refined = 0;
    const effectful = z.array(z.string().transform(value => { transformed++; return value; })).max(1).refine(() => { refined++; return true; });
    assert.equal(effectful.safeParse(['a', 'b']).success, false);
    assert.equal(transformed, patched ? 0 : 2);
    assert.equal(refined, patched ? 0 : 1);
    let asyncTransforms = 0;
    const asynchronous = z.array(z.string().transform(async value => { asyncTransforms++; return value.toUpperCase(); })).max(1);
    assert.equal((await asynchronous.safeParseAsync(['a', 'b'])).success, false);
    assert.equal(asyncTransforms, patched ? 0 : 2);
    assert.deepEqual(await asynchronous.parseAsync(['a']), ['A']);
    const set = z.set(z.string()).max(1).safeParse(new Set(Array.from({length: count}, (_, i) => i)));
    assert.equal(set.error.issues.length, patched ? 1 : count + 1);
    assert.deepEqual([...z.set(z.string()).size(1).parse(new Set(['a']))], ['a']);
    if (!v3) {
      assert.deepEqual(z.array(z.number()).overwrite(value => value.slice(0, 1)).max(1).parse([1, 2]), [1], 'a rewrite before the bound must retain its semantics');
      const collapsed = z.set(z.string().transform(() => 'same')).max(1).safeParse(new Set(['a', 'b']));
      assert.equal(collapsed.success, !patched, 'the upstream security contract caps raw collection size before element transforms');
    }
  } else {
    const set = z.set(z.string()).check(z.maxSize(1)).safeParse(new Set(Array.from({length: count}, (_, i) => i)));
    assert.equal(set.error.issues.length, patched ? 1 : count + 1);
  }
  if (!v3) {
    const map = z.map(z.string(), z.string()).check(mini ? z.maxSize(1) : z.core._maxSize(1));
    const invalid = map.safeParse(new Map([[1, 1], [2, 2]]));
    assert.equal(invalid.error.issues.length, patched ? 1 : 5);
    assert.deepEqual([...map.parse(new Map([['key', 'value']]))], [['key', 'value']]);
    assert.equal(map.safeParse(new Set([1, 2])).error.issues.some(issue => issue.code === 'invalid_type'), true);
  }
  results.push({variant, oversizedIssues: oversized.error.issues.length});
}

const sdk = relative => import(pathToFileURL(path.join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm', relative)));
const {CompleteResultSchema, CompleteRequestSchema} = await sdk('types.js');
assert.equal(CompleteResultSchema.safeParse({completion: {values: ['normal']}}).success, true);
const oversizedCompletion = CompleteResultSchema.safeParse({completion: {values: Array(count).fill(7)}});
assert.equal(oversizedCompletion.error.issues.length, patched ? 1 : count + 1);
if (patched) assert.deepEqual(oversizedCompletion.error.issues[0].path, ['completion', 'values']);
const {Client} = await sdk('client/index.js');
const {Server} = await sdk('server/index.js');
const {InMemoryTransport} = await sdk('inMemory.js');
const client = new Client({name: 'zod-fixture-client', version: '1'});
const server = new Server({name: 'zod-fixture-server', version: '1'}, {capabilities: {completions: {}}});
let values = ['normal'];
server.setRequestHandler(CompleteRequestSchema, async () => ({completion: {values}}));
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const params = {ref: {type: 'ref/prompt', name: 'fixture'}, argument: {name: 'query', value: 'synthetic'}};
  assert.deepEqual((await client.complete(params)).completion.values, ['normal']);
  values = Array(count).fill(7);
  await assert.rejects(client.complete(params), error => {
    assert.equal(error instanceof Error, true);
    assert.equal(patched ? error.message.length < 4096 : error.message.length > 100000, true);
    return true;
  });
  values = ['normal-after-rejection'];
  assert.deepEqual((await client.complete(params)).completion.values, values);
} finally { await client.close(); await server.close(); }
const {SandboxRuntimeConfigSchema} = await import(pathToFileURL(path.join(root, 'node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.js')));
const policy = {network: {allowedDomains: ['example.test'], deniedDomains: ['*'], strictAllowlist: true}, filesystem: {denyRead: ['/synthetic/private'], allowWrite: ['/synthetic/work'], denyWrite: ['/synthetic/work/.git/config']}, allowNestedUserNamespaces: false};
const validated = SandboxRuntimeConfigSchema.parse(policy);
assert.deepEqual(validated.network.allowedDomains, policy.network.allowedDomains);
assert.equal(validated.network.strictAllowlist, true);
assert.equal(validated.allowNestedUserNamespaces, false);
assert.deepEqual(validated.filesystem.denyWrite, policy.filesystem.denyWrite);
assert.equal(SandboxRuntimeConfigSchema.safeParse({...policy, filesystem: {...policy.filesystem, allowWrite: [7]}}).success, false);
console.log(JSON.stringify({phase, results, completionIssues: oversizedCompletion.error.issues.length, protocolRoundTrip: true, sandboxPolicyCompatible: true}));
