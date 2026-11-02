import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from './app';
import { Store } from './store';
import { Wan } from './wan';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('Wan balance reads the documented endpoint and preserves zero balances and unlimited keys', async () => {
  const calls: { url: string; key: string | null; method: string }[] = [];
  const wan = new Wan('https://wan.example', async (url, init) => {
    calls.push({ url: String(url), key: new Headers(init?.headers).get('Authorization'), method: init?.method ?? 'GET' });
    return json({ object: 'balance', currency: 'USD', balance: 0, key_remaining: null, private_field: 'must not be returned' });
  });
  const result = await wan.balance('fake-wan-balance-key');
  assert.deepEqual(calls, [{ url: 'https://wan.example/v1/balance', key: 'Bearer fake-wan-balance-key', method: 'GET' }]);
  assert.equal(result.balance, 0); assert.equal(result.keyRemaining, null); assert.equal(result.currency, 'USD');
  assert(Number.isFinite(Date.parse(result.checkedAt)));
  assert(!JSON.stringify(result).includes('private_field')); assert(!JSON.stringify(result).includes('fake-wan-balance-key'));
});

test('Wan balance rejects malformed values and reports upstream failures without exposing credentials', async () => {
  for (const body of [{ object: 'balance', currency: 'USD', balance: '12.5', key_remaining: null }, { object: 'balance', currency: 'USD', balance: 10 }, { object: 'balance', currency: 'EUR', balance: 10, key_remaining: 5 }]) {
    await assert.rejects(new Wan('https://wan.example', async () => json(body)).balance('fake-wan-balance-key'), /invalid balance response/);
  }
  await assert.rejects(new Wan('https://wan.example', async () => new Response('not json')).balance('fake-wan-balance-key'), /invalid balance response/);
  await assert.rejects(new Wan('https://wan.example', async () => json({ error: { message: 'Balance is temporarily unavailable' } }, 503)).balance('fake-wan-balance-key'), error => error instanceof Error && 'status' in error && error.status === 503);
  await assert.rejects(new Wan('https://wan.example', async () => json({ error: { message: 'Invalid fake-wan-balance-key' } }, 401)).balance('fake-wan-balance-key'), error => error instanceof Error && error.message === 'Invalid [redacted]');
});

async function fixture(wanApiKey?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'frame-balance-'));
  const store = new Store(directory); await store.init();
  const keys: (string | null)[] = [];
  const wan = new Wan('https://wan.example', async (url, init) => {
    assert.equal(String(url), 'https://wan.example/v1/balance');
    const key = new Headers(init?.headers).get('Authorization'); keys.push(key);
    if (key === 'Bearer wan-account-a-test-key') return json({ object: 'balance', currency: 'USD', balance: 12.5, key_remaining: 5 });
    if (key === 'Bearer wan-account-b-test-key') return json({ object: 'balance', currency: 'USD', balance: 0, key_remaining: null });
    if (key === 'Bearer wan-environment-test-key') return json({ object: 'balance', currency: 'USD', balance: 8, key_remaining: null });
    return json({ error: { message: 'Invalid key' } }, 401);
  });
  const studio = createApp({ store, wan, apiKey: 'openrouter-environment-test-key', wanApiKey });
  return { app: studio.app, keys, async close() { await studio.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('balance endpoint uses only the workspace Wan key, isolates accounts, and never caches or returns keys', async () => {
  const f = await fixture();
  try {
    const a = request.agent(f.app); const b = request.agent(f.app);
    await a.get('/api/wan/balance').expect(401); assert.equal(f.keys.length, 0);
    await a.post('/api/connection').send({ provider: 'wan', key: 'wan-account-a-test-key' }).expect(200);
    const first = await a.get('/api/wan/balance').expect(200);
    assert.equal(first.body.balance, 12.5); assert.equal(first.body.keyRemaining, 5);
    assert.equal(first.headers['cache-control'], 'no-store'); assert(!JSON.stringify(first.body).includes('wan-account-a-test-key'));
    await b.get('/api/wan/balance').expect(401);
    await b.post('/api/connection').send({ provider: 'wan', key: 'wan-account-b-test-key' }).expect(200);
    const second = (await b.get('/api/wan/balance').expect(200)).body;
    assert.equal(second.balance, 0); assert.equal(second.keyRemaining, null);
    await a.patch('/api/connection').send({ provider: 'openrouter' }).expect(200);
    assert.equal((await a.get('/api/wan/balance').expect(200)).body.balance, 12.5);
    await a.delete('/api/connection?provider=wan').expect(200);
    await a.get('/api/wan/balance').expect(401);
    assert.equal((await b.get('/api/wan/balance')).body.balance, 0);
    assert(!f.keys.includes('Bearer openrouter-environment-test-key'));
  } finally { await f.close(); }
});

test('balance uses a Wan environment default and returns to it when a saved override is removed', async () => {
  const f = await fixture('wan-environment-test-key');
  try {
    const agent = request.agent(f.app);
    assert.equal((await agent.get('/api/wan/balance').expect(200)).body.balance, 8);
    await agent.post('/api/connection').send({ provider: 'wan', key: 'wan-account-a-test-key' }).expect(200);
    assert.equal((await agent.get('/api/wan/balance')).body.balance, 12.5);
    await agent.delete('/api/connection?provider=wan').expect(200);
    assert.equal((await agent.get('/api/wan/balance')).body.balance, 8);
  } finally { await f.close(); }
});
