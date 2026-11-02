import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from './app';
import { OpenRouter } from './openrouter';
import { Store, type StoredJob } from './store';
import { OutputArchive } from './outputs';
import type { GenerationInput, VideoModel } from '../shared/types';

const model: VideoModel = {
  id: 'test/video', name: 'Test video model', description: '', supported_durations: [5, 10], supported_resolutions: ['720p', '1080p'],
  supported_aspect_ratios: ['16:9', '9:16'], supported_sizes: null, supported_frame_images: ['first_frame', 'last_frame'],
  generate_audio: true, seed: true, pricing_skus: { duration_seconds_1080p: '0.1' }, allowed_passthrough_parameters: ['watermark'],
};
const input: GenerationInput = { model: model.id, prompt: 'A scene with exact saved inputs', duration: 10, resolution: '1080p', aspect_ratio: '9:16', generate_audio: false, seed: 0, provider: { options: { test: { watermark: false } } }, assets: [] };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'frame-jobs-'));
  let store = new Store(directory); await store.init();
  let status = 'pending'; let offline = false; let downloadCount = 0; let submits = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (offline) throw new Error('Provider offline');
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/videos/models')) return json({ data: [model] });
    if (init?.method === 'POST') { submits++; return json({ id: `task-${submits}`, status: 'pending' }); }
    if (parsed.pathname.endsWith('/content')) {
      downloadCount++;
      const bytes = Buffer.from(`saved-video-${parsed.searchParams.get('index')}`);
      return new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } });
    }
    return json({ id: parsed.pathname.split('/').at(-1), status, ...(status === 'completed' ? { urls: ['clip-0', 'clip-1'], usage: { cost: 0.37 } } : {}) });
  };
  const start = (key = true) => createApp({ store, router: new OpenRouter('https://provider.example/api/v1', fetcher), apiKey: key ? 'fake-key-for-local-tests' : undefined, pollInterval: 10 });
  let studio = start();
  return {
    directory, get app() { return studio.app; }, get store() { return store; }, get downloads() { return downloadCount; }, get submits() { return submits; },
    setStatus(value: string) { status = value; }, offline() { offline = true; },
    async restart(key = true) { await studio.close(); store = new Store(directory); await store.init(); studio = start(key); },
    async close() { await studio.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('completed clips and metadata survive restart and remain playable without a provider or key', async () => {
  const f = await fixture();
  try {
    const agent = request.agent(f.app);
    const cookie = (await agent.get('/api/health')).headers['set-cookie'][0].split(';')[0];
    const job = (await agent.post('/api/jobs').send(input).expect(202)).body.job;
    f.store.data.jobs[0].createdAt = new Date(Date.now() - 65_000).toISOString();
    f.setStatus('in_progress'); await waitFor(async () => (await agent.get('/api/jobs')).body.jobs[0].startedAt);
    f.setStatus('completed');
    const saved = await waitFor(async () => { const job = (await agent.get('/api/jobs')).body.jobs[0]; return job.storage?.status === 'saved' && job; });
    assert.equal(saved.cost, 0.37); assert.equal(saved.estimatedCost, 1); assert.equal(saved.modelName, model.name);
    assert(saved.generationTimeMs >= 65_000); assert(saved.finishedAt); assert(saved.startedAt);
    assert.equal(saved.outputs.length, 2); assert.equal(f.downloads, 2);
    for (let index = 0; index < 2; index++) {
      const path = join(f.store.outputs, `${job.id}-${index}.mp4`);
      assert.equal(await readFile(path, 'utf8'), `saved-video-${index}`);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    f.offline(); await f.restart(false);
    const range = await request(f.app).get(`/api/jobs/${job.id}/content?index=1`).set('Cookie', cookie).set('Range', 'bytes=0-4').expect(206);
    assert.equal(range.headers['content-range'], 'bytes 0-4/13'); assert.equal(range.body.toString(), 'saved');
    await request(f.app).get(`/api/jobs/${job.id}/content?download=1`).set('Cookie', cookie).expect('Content-Disposition', /attachment/).expect(200);
    await request(f.app).head(`/api/jobs/${job.id}/content`).set('Cookie', cookie).expect('Content-Length', '13').expect(200);
    await request(f.app).get(`/api/jobs/${job.id}/content`).expect(404);
    assert.equal(f.downloads, 2); assert.equal(f.submits, 1);
    const restored = (await request(f.app).get('/api/jobs').set('Cookie', cookie)).body.jobs[0];
    assert.equal(restored.finishedAt, saved.finishedAt); assert.equal(restored.generationTimeMs, saved.generationTimeMs); assert.equal(restored.cost, saved.cost);
    await request(f.app).delete(`/api/jobs/${job.id}`).set('Cookie', cookie).expect(204);
    assert.deepEqual(await readdir(f.store.outputs), []);
  } finally { await f.close(); }
});

test('reuse restores exact prepared references and all generation settings, skipping deleted materials', async () => {
  const f = await fixture();
  try {
    const agent = request.agent(f.app);
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'green' } }).png().toBuffer();
    const asset = (await agent.post('/api/assets').attach('files', png, 'First frame.png').expect(201)).body.assets[0];
    await agent.post(`/api/assets/${asset.id}/prepare`).send({ maxWidth: 32 }).expect(202);
    const first = await waitFor(async () => { const asset = (await agent.get('/api/assets')).body.assets[0]; return asset.preparation?.status === 'completed' && asset; });
    const job = (await agent.post('/api/jobs').send({ ...input, assets: [{ id: asset.id, role: 'first_frame' }] }).expect(202)).body.job;
    assert.equal(job.references[0].preparedId, first.prepared.id);
    assert.equal(job.references[0].snapshot.prepared.metadata.width, 32);
    assert.equal(job.references[0].snapshot.owner, undefined); assert.equal(job.references[0].snapshot.filename, undefined);
    await agent.post(`/api/assets/${asset.id}/prepare`).send({ maxWidth: 16 }).expect(202);
    await waitFor(async () => (await agent.get('/api/assets')).body.assets[0].preparation?.status === 'completed');
    const reused = (await agent.get(`/api/jobs/${job.id}/reuse`).expect(200)).body;
    assert.deepEqual(reused.input, { ...input, apiProvider: 'openrouter', assets: [{ id: asset.id, role: 'first_frame', preparedId: first.prepared.id }] });
    assert.equal(reused.references[0].snapshot.prepared.metadata.width, 32); assert.equal(reused.unavailableReferences, 0);
    await request(f.app).get(`/api/jobs/${job.id}/reuse`).expect(404);
    // Legacy jobs can still reconstruct their pinned input from the asset library.
    delete f.store.data.jobs[0].references;
    assert.equal((await agent.get(`/api/jobs/${job.id}/reuse`)).body.references[0].preparedId, first.prepared.id);
    await agent.delete(`/api/assets/${asset.id}`).expect(204);
    const missing = (await agent.get(`/api/jobs/${job.id}/reuse`)).body;
    assert.equal(missing.unavailableReferences, 1); assert.deepEqual(missing.input.assets, []);
  } finally { await f.close(); }
});

function completedJob(): StoredJob {
  return { id: randomUUID(), owner: 'a'.repeat(64), upstreamId: 'existing-task', title: 'Existing video', status: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), input, outputCount: 2 };
}

test('interrupted archive downloads are cleaned up and retried without downloading saved clips again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frame-archive-'));
  const store = new Store(directory); await store.init();
  const job = completedJob(); store.data.jobs.push(job);
  const counts = [0, 0];
  const archive = new OutputArchive(store, async (_job, index) => {
    counts[index]++;
    if (index === 1 && counts[index] === 1) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.error(new Error('Connection dropped')); } }), { headers: { 'content-type': 'video/mp4' } });
    return new Response(`clip ${index}`, { headers: { 'content-type': 'video/mp4' } });
  }, 10);
  try {
    await assert.rejects(archive.ensure(job), /local copy/);
    assert.equal(job.status, 'completed'); assert.equal(job.storage?.status, 'failed');
    assert.equal((await readdir(store.outputs)).some(name => name.endsWith('.part')), false);
    await waitFor(async () => job.storage?.status === 'saved');
    assert.deepEqual(counts, [1, 2]); assert.equal(job.outputs?.length, 2);
  } finally { await archive.close(); await rm(directory, { recursive: true, force: true }); }
});

test('archive recovers final files after an interrupted metadata write without contacting the provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frame-recovered-'));
  const store = new Store(directory); await store.init();
  const job = completedJob(); store.data.jobs.push(job);
  const archive = new OutputArchive(store, async () => { throw new Error('Provider must not be called'); });
  try {
    for (let index = 0; index < 2; index++) await writeFile(archive.path(job, index), `recovered-${index}`, { mode: 0o600 });
    await archive.ensure(job);
    assert.equal(job.storage?.status, 'saved'); assert.equal(job.outputs?.length, 2);
  } finally { await archive.close(); await rm(directory, { recursive: true, force: true }); }
});

test('older completed jobs automatically backfill local copies on startup', async () => {
  const f = await fixture();
  try {
    const job = completedJob(); f.store.data.jobs.push(job); await f.store.save();
    await f.restart();
    await waitFor(async () => f.store.data.jobs[0].storage?.status === 'saved');
    assert.equal(f.downloads, 2); assert.equal(f.submits, 0);
  } finally { await f.close(); }
});

async function waitFor<T>(read: () => Promise<T | false | undefined>): Promise<T> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for saved state');
}
