import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createBazanticApi, type BazanticDependencies } from './route.js';
import { createPublicApi } from '../public-api/route.js';
import { decode } from '../../src/x402/server.js';

const secret = 'test-only-bazantic-secret';
const taskId = '00000000-0000-0000-0000-000000000123';
const origin = 'https://mesh402.example';
const spec = JSON.parse(await readFile(new URL('../../frontend/public/bazantic-openapi.json', import.meta.url), 'utf8'));
const publicSpec = JSON.parse(await readFile(new URL('../../frontend/public/openapi.json', import.meta.url), 'utf8'));
async function fixture(overrides: Partial<BazanticDependencies> = {}, configuredSecret = secret) {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'mesh402-bazantic-'));
  const calls = { generate: 0, persist: 0 };
  const deps: BazanticDependencies = {
    generate: async prompt => { calls.generate++; assert.equal(prompt, 'robot'); return { taskId, glbUrl: 'https://temporary.invalid/model.glb', consumedCredit: 20 }; },
    persist: async () => { calls.persist++; const file = resolve(dataDir, `${taskId}.glb`); await writeFile(file, 'mock-glb'); return { localGlbPath: file, glbBytes: 8 }; },
    ...overrides,
  };
  const config = { origin, dataDir, secret: configuredSecret, providerReady: true };
  const accepted = { scheme: 'exact', network: 'hedera:testnet', amount: '100000', asset: '0.0.0', payTo: '0.0.456', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.789' } } as const;
  const forbidden = () => { throw new Error('No real payment or public generation permitted in this test'); };
  const publicApi = await createPublicApi({ enabled: true, origin, dataDir, recipient: '0.0.456', providerReady: true, maxGenerations: 5, maxConcurrent: 1 }, {
    discover: async () => accepted, facilitator: forbidden, inspect: forbidden, generate: forbidden, persist: forbidden,
  });
  const servers: ReturnType<typeof createServer>[] = [];
  async function start() {
    const bazantic = await createBazanticApi(config, deps);
    const server = createServer(async (req, res) => {
      if (await publicApi(req, res)) return;
      if (await bazantic(req, res)) return;
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); servers.push(server);
    return `http://127.0.0.1:${(server.address() as any).port}`;
  }
  const base = await start();
  const post = (key?: string, body: unknown = { prompt: 'robot' }, baseUrl = base) => fetch(baseUrl + '/api/bazantic/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(key === undefined ? {} : { 'X-Bazantic-Upstream-Secret': key }) }, body: JSON.stringify(body),
  });
  return { dataDir, calls, base, post, start, async close() {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    await rm(dataDir, { recursive: true, force: true });
  } };
}

test('dedicated spec advertises only the secret-protected Bazantic operation', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(Object.keys(spec.paths), ['/api/bazantic/generate']);
  const post = spec.paths['/api/bazantic/generate'].post;
  assert.deepEqual(post.security, [{ BazanticUpstreamSecret: [] }]);
  assert.deepEqual(spec.components.securitySchemes.BazanticUpstreamSecret, {
    type: 'apiKey', in: 'header', name: 'X-Bazantic-Upstream-Secret',
    description: 'Private server-to-server credential injected by the paid gateway. Never send it to end users or browser code.',
  });
  assert.equal(post.responses['402'], undefined);
  assert.deepEqual(spec.components.schemas.GenerateRequest, publicSpec.components.schemas.GenerateRequest);
});

test('missing/wrong secret and invalid input never reach generation', async () => {
  const f = await fixture();
  try {
    for (const key of [undefined, '', 'wrong', secret + 'wrong']) {
      const r = await f.post(key); assert.equal(r.status, 401); assert.equal((await r.json()).error.code, 'unauthorized');
      assert.equal(r.headers.get('payment-required'), null);
    }
    for (const body of [{}, {prompt: ''}, {prompt: '  '}, {prompt: 123}, {prompt: 'x'.repeat(2001)}, {prompt: 'robot', extra: true}]) {
      assert.equal((await f.post(secret, body)).status, 400);
    }
    assert.deepEqual(f.calls, {generate: 0, persist: 0});
  } finally { await f.close(); }
  const disabled = await fixture({}, '');
  try { assert.equal((await disabled.post(secret)).status, 503); assert.equal(disabled.calls.generate, 0); }
  finally { await disabled.close(); }
});

test('valid upstream credential generates once, persists public metadata, and leaves public x402 unchanged', async () => {
  const f = await fixture();
  try {
    const r = await f.post(secret, {prompt: '  robot  '}); assert.equal(r.status, 200);
    assert.equal(r.headers.get('payment-required'), null); assert.equal(r.headers.get('payment-response'), null);
    const result = await r.json();
    assert.deepEqual(result, { status: 'success', taskId, assetUrl: `${origin}/api/bazantic/assets/${taskId}.glb`, receiptUrl: `${origin}/api/bazantic/receipts/${taskId}.json`, creditsConsumed: 20, glbBytes: 8, prompt: 'robot' });
    assert.deepEqual(Object.keys(result).sort(), spec.components.schemas.GeneratedAsset.required.toSorted());
    for (const forbidden of [secret, f.dataDir, 'temporary.invalid']) assert.ok(!JSON.stringify(result).includes(forbidden));
    assert.deepEqual(f.calls, {generate: 1, persist: 1});
    const restarted = await f.start();
    const asset = await fetch(restarted + `/api/bazantic/assets/${taskId}.glb`);
    assert.equal(asset.status, 200); assert.equal(asset.headers.get('content-type'), 'model/gltf-binary'); assert.equal(await asset.text(), 'mock-glb');
    assert.deepEqual(await fetch(restarted + `/api/bazantic/receipts/${taskId}.json`).then(r => r.json()), result);
    assert.equal((await fetch(restarted + '/api/bazantic/assets/00000000-0000-0000-0000-000000000999.glb')).status, 404);
    const unpaid = await fetch(f.base + '/api/v1/generate', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Bazantic-Upstream-Secret': secret}, body: JSON.stringify({prompt: 'robot'})});
    assert.equal(unpaid.status, 402); const offer = await unpaid.json();
    assert.deepEqual(decode(unpaid.headers.get('payment-required')!), offer);
    assert.equal(offer.x402Version, 2); assert.equal(offer.accepts[0].network, 'hedera:testnet'); assert.equal(offer.accepts[0].amount, '100000');
    assert.equal(f.calls.generate, 1);
  } finally { await f.close(); }
});

test('concurrent calls cannot overlap and ambiguous failures remain blocked after restart', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
  let calls = 0;
  const f = await fixture({ generate: async () => { calls++; entered(); await gate; throw new Error('Simulated provider timeout'); } });
  try {
    const first = f.post(secret); await started;
    assert.equal((await f.post(secret)).status, 409);
    release(); const result = await first; assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), {error: {code: 'execution_requires_reconciliation'}, taskId: null, retryable: false});
    assert.equal((await f.post(secret)).status, 409);
    const restarted = await f.start(); assert.equal((await f.post(secret, {prompt: 'robot'}, restarted)).status, 409);
    assert.equal(calls, 1); assert.equal(f.calls.persist, 0);
  } finally { release(); await f.close(); }
});
