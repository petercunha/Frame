import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from './app';
import { Store, type StoredAsset } from './store';
import { OpenRouter } from './openrouter';
import { Wan, wanModel } from './wan';
import { buildWanRequest, validateWanReferences } from './generation';
import type { GenerationInput } from '../shared/types';
import { ReferenceHost } from './reference-host';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=', 'base64');
const input: GenerationInput = { apiProvider: 'wan', model: wanModel.id, prompt: 'A blue ball rolls', duration: 5, resolution: '720p', aspect_ratio: '16:9', generate_audio: false, seed: 42, assets: [] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'frame-providers-'));
  const calls: { url: URL; init?: RequestInit }[] = [];
  let status = 'processing';
  let failPoll = false;
  const fetcher: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, init });
    if (parsed.hostname === 'cdn.example') return new Response('video bytes', { status: new Headers(init?.headers).has('Range') ? 206 : 200, headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' } });
    const key = new Headers(init?.headers).get('Authorization');
    if (parsed.pathname === '/v1/balance' || parsed.pathname === '/api/v1/key') return key?.includes('valid-') ? json({ balance: 10 }) : json({ error: { message: 'Invalid API key' } }, 401);
    if (parsed.pathname.endsWith('/videos/models')) return json({ data: [{ ...wanModel, id: 'alibaba/wan-3.0' }] });
    if (init?.method === 'POST') return parsed.hostname === 'wan.example' ? json({ task_info: { id: 'wan-task', status: 'pending' } }, 202) : json({ id: 'router-task', status: 'pending' }, 202);
    if (failPoll) { failPoll = false; return json({ error: { message: 'Rate limited' } }, 429); }
    if (parsed.hostname === 'wan.example') return json({ task_info: { id: 'wan-task', status }, ...(status === 'completed' ? { videos: ['https://cdn.example/output.mp4?token=signed'] } : status === 'failed' ? { error: { message: 'Generation failed' } } : {}) });
    return json({ id: 'router-task', status: 'completed' });
  };
  let store = new Store(directory); await store.init();
  const start = () => createApp({ store, router: new OpenRouter('https://router.example/api/v1', fetcher), wan: new Wan('https://wan.example', fetcher), apiKey: 'valid-router-env', wanApiKey: 'valid-wan-env', pollInterval: 10, references: new ReferenceHost(join(directory, 'exports'), { publicOrigin: 'https://references.example' }) });
  let studio = start();
  return {
    directory, calls, get store() { return store; }, get app() { return studio.app; },
    setStatus(value: string) { status = value; }, failNextPoll() { failPoll = true; },
    async restart() { await studio.close(); store = new Store(directory); await store.init(); studio = start(); },
    async close() { await studio.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('provider keys and mode survive restart, stay workspace-private, and can be removed independently', async () => {
  const f = await fixture();
  try {
    const agent = request.agent(f.app);
    const cookie = (await agent.get('/api/connection')).headers['set-cookie'][0].split(';')[0];
    await agent.post('/api/connection').send({ provider: 'openrouter', key: 'valid-saved-router-key' }).expect(200);
    const saved = await agent.post('/api/connection').send({ provider: 'wan', key: 'valid-saved-wan-key' }).expect(200);
    assert.deepEqual(saved.body, { provider: 'wan', connected: true, source: 'saved' });
    await agent.post('/api/connection').send({ provider: 'wan', key: 'rejected-key' }).expect(401);
    const credentialPath = join(f.directory, 'credentials.json');
    assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
    const credentials = await readFile(credentialPath, 'utf8');
    assert(credentials.includes('valid-saved-wan-key')); assert(!credentials.includes('rejected-key'));
    await f.restart();
    const restored = await request(f.app).get('/api/connection').set('Cookie', cookie).expect(200);
    assert.deepEqual(restored.body, saved.body);
    assert(!JSON.stringify(restored.body).includes('valid-saved'));
    await request(f.app).post('/api/jobs').set('Cookie', cookie).send(input).expect(202);
    assert.equal(new Headers(f.calls.find(call => call.init?.method === 'POST')?.init?.headers).get('Authorization'), 'Bearer valid-saved-wan-key');
    assert.deepEqual((await request(f.app).get('/api/connection')).body, { provider: 'openrouter', connected: true, source: 'environment' });
    await request(f.app).delete('/api/connection?provider=wan').set('Cookie', cookie).expect(200);
    await request(f.app).patch('/api/connection').set('Cookie', cookie).send({ provider: 'openrouter' }).expect(200);
    assert.equal((await request(f.app).get('/api/connection').set('Cookie', cookie)).body.source, 'saved');
    await f.restart();
    assert(!(await readFile(credentialPath, 'utf8')).includes('valid-saved-wan-key'));
    assert.equal((await request(f.app).patch('/api/connection').set('Cookie', cookie).send({ provider: 'wan' })).body.source, 'environment');
    await request(f.app).patch('/api/connection').send({ provider: 'unknown' }).expect(400);
    await request(f.app).get('/api/models?provider=unknown').expect(400);
  } finally { await f.close(); }
});

test('Wan offers only Wan 3.0, maps its payload, and keeps polling/downloading on Wan after a provider switch and restart', async () => {
  const f = await fixture();
  try {
    const agent = request.agent(f.app);
    const cookie = (await agent.get('/api/connection')).headers['set-cookie'][0].split(';')[0];
    await agent.patch('/api/connection').send({ provider: 'wan' }).expect(200);
    assert.deepEqual((await agent.get('/api/models')).body.models, [wanModel]);
    await agent.post('/api/jobs').send({ ...input, model: 'wan3.0-prime' }).expect(400);
    f.failNextPoll();
    const created = (await agent.post('/api/jobs').send({ ...input, apiProvider: undefined }).expect(202)).body.job;
    assert.equal(created.apiProvider, 'wan');
    const submission = f.calls.find(call => call.init?.method === 'POST')!;
    assert.equal(submission.url.pathname, '/wan/v1/wan3.0-video/generation');
    assert.equal(new Headers(submission.init?.headers).get('Authorization'), 'Bearer valid-wan-env');
    const { prompt_extend: _promptExtend, nsfw_checker: _nsfwChecker, ...payload } = JSON.parse(String(submission.init?.body));
    assert.deepEqual(payload, { prompt: input.prompt, duration: 5, resolution: '720p', ratio: '16:9', audio: false, seed: 42 });
    await waitFor(agent, created.id, 'in_progress');
    await agent.patch('/api/connection').send({ provider: 'openrouter' }).expect(200);
    await f.restart();
    f.setStatus('completed');
    const resumed = request.agent(f.app);
    await resumed.get('/api/jobs').set('Cookie', cookie).expect(200);
    // Keep the same workspace cookie across the restarted server.
    const deadline = Date.now() + 3000;
    let job;
    while (Date.now() < deadline) {
      job = (await request(f.app).get('/api/jobs').set('Cookie', cookie)).body.jobs[0];
      if (job.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.equal(job.status, 'completed');
    await request(f.app).get(`/api/jobs/${created.id}/content?download=1`).set('Cookie', cookie).set('Range', 'bytes=0-4').expect(206);
    const download = f.calls.find(call => call.url.hostname === 'cdn.example')!;
    assert.equal(new Headers(download.init?.headers).get('Authorization'), null);
    assert.equal(new Headers(download.init?.headers).get('Range'), 'bytes=0-4');
    assert(!f.calls.some(call => call.url.hostname === 'router.example' && call.url.pathname.includes('/wan-task')));
    assert.equal(f.calls.filter(call => call.init?.method === 'POST').length, 1);
    const stored = await readFile(join(f.directory, 'studio.json'), 'utf8');
    assert(!stored.includes('valid-wan-env')); assert(!stored.includes('token=signed'));
  } finally { await f.close(); }
});

test('Wan publishes image references and frames as HTTPS snapshots and releases them after completion', async () => {
  const f = await fixture();
  try {
    const agent = request.agent(f.app);
    const asset = (await agent.post('/api/assets').attach('files', png, 'frame.png').expect(201)).body.assets[0];
    const created = (await agent.post('/api/jobs').send({ ...input, prompt: '', assets: [{ id: asset.id, role: 'first_frame' }] }).expect(202)).body.job;
    const body = JSON.parse(String(f.calls.find(call => call.init?.method === 'POST')!.init?.body));
    assert.match(body.first_frame, /^https:\/\/references.example\/_frame_references\/[a-f0-9]{64}\/input.png$/);
    assert.equal(body.frame_images, undefined);
    const path = new URL(body.first_frame).pathname;
    await request(f.app).get(path).expect(200);
    await agent.delete(`/api/assets/${asset.id}`).expect(204);
    await request(f.app).get(path).expect(200);
    f.setStatus('completed'); await waitFor(agent, created.id, 'completed');
    await request(f.app).get(path).expect(404);
  } finally { await f.close(); }
});

test('Wan rejects invalid reference limits before submitting and maps all native reference fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frame-wan-inputs-'));
  try {
    const kinds = ['image', 'video', 'audio'] as const;
    const assets: StoredAsset[] = kinds.map(kind => ({ id: kind, owner: 'owner', name: kind, mime: kind === 'video' ? 'video/mp4' : `${kind}/example`, kind, size: 5, filename: kind, createdAt: '', url: '', metadata: { duration: 5 } }));
    const references = { ...input, assets: kinds.map(id => ({ id, role: 'reference' as const })) };
    validateWanReferences(references, assets);
    const body = await buildWanRequest(references, assets, directory, directory, async source => `https://media.example/${source.kind}`);
    assert.deepEqual(body.reference_images, ['https://media.example/image']);
    assert.deepEqual(body.reference_videos, ['https://media.example/video']);
    assert.deepEqual(body.reference_audios, ['https://media.example/audio']);
    assert.equal(body.model, undefined); assert.equal(body.apiProvider, undefined);
    assert.throws(() => validateWanReferences({ ...references, duration: 30 }, assets), /30 seconds/);
    assert.throws(() => validateWanReferences(references, assets.map(asset => asset.kind === 'video' ? { ...asset, mime: 'video/webm' } : asset)), /MP4 or MOV/);
    assert.throws(() => validateWanReferences(references, assets.map(asset => asset.kind === 'video' ? { ...asset, metadata: { duration: 16 } } : asset)), /1–15 seconds/);
    assert.throws(() => validateWanReferences({ ...input, assets: Array.from({ length: 11 }, () => ({ id: 'image', role: 'reference' })) }, assets), /at most 10 image/);
    await assert.rejects(buildWanRequest(references, assets, directory, directory, async () => 'data:image/png;base64,abc'), /HTTPS/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Wan reports failed jobs, rejects bad receipts, and never retries uncertain submissions', async () => {
  const f = await fixture();
  try {
    const agent = request.agent(f.app); f.setStatus('failed');
    const job = (await agent.post('/api/jobs').send(input).expect(202)).body.job;
    assert.match((await waitFor(agent, job.id, 'failed')).error, /Generation failed/);
    let submissions = 0;
    const wan = new Wan('https://wan.example', async () => { submissions++; throw new Error('network interrupted'); });
    await assert.rejects(wan.submit('fake-test-key', {}), /avoid a duplicate charge/);
    assert.equal(submissions, 1);
    await assert.rejects(new Wan('https://wan.example', async () => json({ task_info: { status: 'pending' } })).submit('fake-test-key', {}), /invalid task receipt/);
  } finally { await f.close(); }
});

test('concurrent saved-key writes preserve both providers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frame-credentials-'));
  try {
    const store = new Store(directory); await store.init();
    const owner = 'a'.repeat(64);
    await Promise.all([store.connections.update(owner, 'openrouter', 'fake-router-key'), store.connections.update(owner, 'wan', 'fake-wan-key')]);
    const restored = new Store(directory); await restored.init();
    assert.equal(restored.connections.key(owner, 'openrouter'), 'fake-router-key');
    assert.equal(restored.connections.key(owner, 'wan'), 'fake-wan-key');
    assert.equal(restored.connections.provider(owner), 'wan');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function waitFor(agent: ReturnType<typeof request.agent>, id: string, status: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const job = (await agent.get('/api/jobs')).body.jobs.find((job: { id: string }) => job.id === id);
    if (job?.status === status) return job;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${status}`);
}
