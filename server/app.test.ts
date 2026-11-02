import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from './app';
import { OpenRouter } from './openrouter';
import { Store, type StoredAsset } from './store';
import { buildRequest, validateGeneration } from './generation';
import { estimateCost, type GenerationInput, type VideoModel } from '../shared/types';
import { ReferenceHost } from './reference-host';

const model: VideoModel = {
  id: 'alibaba/wan-3.0', name: 'Alibaba: Wan 3.0', description: 'Test model',
  supported_durations: [2, 5, 10], supported_resolutions: ['480p', '720p', '1080p'],
  supported_aspect_ratios: ['16:9', '9:16'], supported_sizes: ['1280x720'],
  supported_frame_images: ['first_frame', 'last_frame'], generate_audio: true, seed: true,
  pricing_skus: { duration_seconds_720p: '0.1' }, allowed_passthrough_parameters: ['watermark'],
};
const input: GenerationInput = { model: model.id, prompt: 'A quiet cinematic forest scene', duration: 5, resolution: '720p', aspect_ratio: '16:9', generate_audio: true, assets: [] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=', 'base64');
let directory: string;
let store: Store;
let studio: ReturnType<typeof createApp>;
let lastSubmission: Record<string, unknown>;
let lastRange: string | null = null;
let nextStatus = 'completed';
let submitCount = 0;
let nextPollError = false;
const bytes = Buffer.from('mock-video-content');
const fetcher: typeof fetch = async (url, init) => {
  const path = new URL(String(url)).pathname;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (path.endsWith('/videos/models')) return json({ data: [model] });
  if (path.endsWith('/key')) return new Headers(init?.headers).get('Authorization') === 'Bearer valid-test-key' ? json({ data: {} }) : json({ error: { message: 'Invalid test key' } }, 401);
  if (path.endsWith('/videos') && init?.method === 'POST') {
    lastSubmission = JSON.parse(String(init.body));
    const references = lastSubmission.input_references as { type: string; video_url?: { url: string }; audio_url?: { url: string } }[] | undefined;
    for (const [index, reference] of (references ?? []).entries()) {
      const url = reference.video_url?.url ?? reference.audio_url?.url;
      if (url && !url.startsWith('https://')) return json({ error: { message: `Invalid reference URL: input_references[${index}].${reference.type}.url: Only HTTPS URLs are allowed` } }, 400);
    }
    submitCount++;
    return json({ id: `upstream-${submitCount}`, status: 'pending' }, 202);
  }
  if (path.endsWith('/content')) {
    lastRange = new Headers(init?.headers).get('Range');
    return new Response(bytes, { status: lastRange ? 206 : 200, headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', ...(lastRange ? { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` } : {}) } });
  }
  if (nextPollError) { nextPollError = false; return json({ error: { message: 'Temporarily rate limited' } }, 429); }
  return json({ id: path.split('/').at(-1), status: nextStatus, ...(nextStatus === 'failed' ? { error: 'Provider rejected this generation' } : { unsigned_urls: ['output-0', 'output-1'], usage: { cost: 0.5 } }) });
};
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'frame-tests-'));
  store = new Store(directory); await store.init();
  studio = createApp({ store, router: new OpenRouter('https://mock.invalid/api/v1', fetcher), pollInterval: 10, references: new ReferenceHost(join(directory, 'exports'), { publicOrigin: 'https://references.example' }) });
});
after(async () => { await studio.close(); await rm(directory, { recursive: true, force: true }); });

test('a key is required; valid saved keys are checked and never returned', async () => {
  const agent = request.agent(studio.app);
  await agent.post('/api/jobs').send(input).expect(401);
  await agent.post('/api/connection').send({ key: 'bad-test-key' }).expect(401);
  const connected = await agent.post('/api/connection').send({ key: 'valid-test-key' }).expect(200);
  assert.deepEqual(connected.body, { provider: 'openrouter', connected: true, source: 'saved' });
  assert(!JSON.stringify(connected.body).includes('valid-test-key'));
  await agent.delete('/api/connection').expect(200);
  await agent.post('/api/jobs').send(input).expect(401);
});

test('live model discovery is normalized', async () => {
  const result = await request(studio.app).get('/api/models').expect(200);
  assert.deepEqual(result.body.models, [model]);
});

test('media uploads validate bytes, persist, and remain private to the browser session', async () => {
  const agent = request.agent(studio.app);
  const result = await agent.post('/api/assets').attach('files', png, 'scene.png').expect(201);
  const asset = result.body.assets[0];
  assert.equal(asset.kind, 'image');
  assert.equal(asset.owner, undefined); assert.equal(asset.filename, undefined);
  await agent.get(asset.url).expect('Content-Type', /image\/png/).expect(200);
  await request(studio.app).get(asset.url).expect(404);
  assert.equal((await agent.get('/api/assets')).body.assets.length, 1);
  await agent.post('/api/assets').attach('files', Buffer.from('<script>alert(1)</script>'), 'fake.png').expect(400);
  assert.equal((await agent.get('/api/assets')).body.assets.length, 1);
  await agent.delete(`/api/assets/${asset.id}`).expect(204);
  await agent.get(asset.url).expect(404);
});

test('text generation progresses asynchronously, persists cost, streams clips and forwards ranges', async () => {
  nextStatus = 'completed';
  const agent = request.agent(studio.app);
  await agent.post('/api/connection').send({ key: 'valid-test-key' });
  const result = await agent.post('/api/jobs').send(input).expect(202);
  assert.equal(result.body.job.status, 'pending');
  const id = result.body.job.id;
  await agent.get(`/api/jobs/${id}/content`).expect(409);
  const job = await waitForStatus(agent, id, 'completed');
  assert.equal(job.cost, 0.5); assert.equal(job.outputCount, 2);
  const { assets: _assets, ...expected } = input;
  assert.deepEqual(lastSubmission, expected);
  const downloaded = await agent.get(`/api/jobs/${id}/content?index=1&download=1`).expect(200);
  assert.match(downloaded.headers['content-disposition'], /attachment/);
  assert.match(downloaded.headers['content-type'], /video\/mp4/);
  await agent.get(`/api/jobs/${id}/content`).set('Range', 'bytes=0-17').expect(206);
  assert.equal(lastRange, 'bytes=0-17');
  await agent.get(`/api/jobs/${id}/content?index=2`).expect(400);
  await request(studio.app).get(`/api/jobs/${id}/content`).expect(404);
  const saved = JSON.parse(await readFile(join(directory, 'studio.json'), 'utf8'));
  assert.equal(saved.jobs.find((j: { id: string }) => j.id === id).cost, 0.5);
  assert(!JSON.stringify(saved).includes('valid-test-key'));
  await agent.delete(`/api/jobs/${id}`).expect(204);
});

test('provider failures become terminal job errors and transient polling failures retry', async () => {
  nextStatus = 'failed'; nextPollError = true;
  const agent = request.agent(studio.app);
  await agent.post('/api/connection').send({ key: 'valid-test-key' });
  const result = await agent.post('/api/jobs').send(input).expect(202);
  const job = await waitForStatus(agent, result.body.job.id, 'failed');
  assert.equal(job.error, 'Provider rejected this generation');
  assert.equal(job.pollError, undefined);
  nextStatus = 'completed';
});

test('frame conditioning sends base64 bytes and rejects mixed reference and frame modes', async () => {
  const agent = request.agent(studio.app);
  await agent.post('/api/connection').send({ key: 'valid-test-key' });
  const result = await agent.post('/api/assets').attach('files', png, 'first.png').attach('files', png, 'second.png');
  const [first, second] = result.body.assets;
  await agent.post('/api/jobs').send({ ...input, assets: [{ id: first.id, role: 'first_frame' }, { id: second.id, role: 'reference' }] }).expect(400);
  await agent.post('/api/jobs').send({ ...input, prompt: '', assets: [{ id: first.id, role: 'first_frame' }] }).expect(202);
  const frames = lastSubmission.frame_images as { image_url: { url: string }; frame_type: string }[];
  assert.equal(frames[0].frame_type, 'first_frame');
  assert.equal(frames[0].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(lastSubmission.assets, undefined);
});

test('validation rejects unsupported model parameters and unapproved provider options before billing', async () => {
  const agent = request.agent(studio.app);
  await agent.post('/api/connection').send({ key: 'valid-test-key' });
  const before = submitCount;
  for (const patch of [{ duration: 30 }, { resolution: '8K' }, { aspect_ratio: '2:3' }, { prompt: '' }, { seed: -1 }, { model: 'nonexistent/model' }, { provider: { options: { byteplus: { unknown: true } } } }]) {
    await agent.post('/api/jobs').send({ ...input, ...patch }).expect(400);
  }
  assert.equal(before, submitCount);
  assert.throws(() => validateGeneration({ ...input, seed: 3 }, { ...model, seed: false }, []), /seed/);
});

test('image, audio, and video reference payloads use the documented discriminated types', async () => {
  const kinds = ['image', 'audio', 'video'] as const;
  const assets: StoredAsset[] = [];
  for (const kind of kinds) {
    await writeFile(join(store.uploads, `reference-${kind}`), 'asset bytes');
    assets.push({ id: kind, owner: 'test', name: kind, kind, mime: `${kind}/example`, filename: `reference-${kind}`, size: 11, createdAt: '', url: '' });
  }
  const published: string[] = [];
  const body = await buildRequest({ ...input, assets: kinds.map(id => ({ id, role: 'reference' })) }, assets, store.uploads, store.prepared, async source => { published.push(source.path); return `https://references.example/${source.kind}`; });
  assert(body.input_references);
  assert.deepEqual(body.input_references.map(reference => reference.type), ['image_url', 'audio_url', 'video_url']);
  assert.equal((body.input_references[0].image_url as { url: string }).url, `data:image/example;base64,${Buffer.from('asset bytes').toString('base64')}`);
  assert.equal((body.input_references[1].audio_url as { url: string }).url, 'https://references.example/audio');
  assert.equal((body.input_references[2].video_url as { url: string }).url, 'https://references.example/video');
  assert.equal(published.length, 2);
  await assert.rejects(buildRequest({ ...input, assets: [{ id: 'video', role: 'reference' }] }, assets, store.uploads), /HTTPS hosting/);
});

test('video references use HTTPS snapshots, survive library deletion, and are revoked after completion', async () => {
  nextStatus = 'pending';
  const agent = request.agent(studio.app);
  await agent.post('/api/connection').send({ key: 'valid-test-key' });
  const video = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
  const asset = (await agent.post('/api/assets').attach('files', video, 'reference.mp4').expect(201)).body.assets[0];
  const result = await agent.post('/api/jobs').send({ ...input, assets: [{ id: asset.id, role: 'reference' }] }).expect(202);
  const url = (lastSubmission.input_references as { video_url: { url: string } }[])[0].video_url.url;
  assert.match(url, /^https:\/\/references\.example\/_frame_references\/[a-f0-9]{64}\/input.mp4$/);
  const path = new URL(url).pathname;
  await request(studio.app).get(path).expect(200);
  await request(studio.app).get(path).set('Range', 'bytes=0-5').expect(206);
  await agent.delete(`/api/assets/${asset.id}`).expect(204);
  await request(studio.app).get(path).expect(200);
  nextStatus = 'completed'; await waitForStatus(agent, result.body.job.id, 'completed');
  await request(studio.app).get(path).expect(404);
});

test('cross-origin writes, malformed JSON, and unknown routes fail cleanly', async () => {
  await request(studio.app).post('/api/connection').set('Origin', 'https://elsewhere.invalid').send({ key: 'valid-test-key' }).expect(403);
  await request(studio.app).post('/api/jobs').set('Content-Type', 'application/json').send('{').expect(400);
  await request(studio.app).get('/api/missing').expect(404);
});

test('cost estimates use units correctly and avoid guessing token-based pricing', () => {
  assert.equal(estimateCost(model, 5, '720p', false), 0.5);
  assert.equal(estimateCost({ ...model, pricing_skus: { cents_per_second_output_720p: '12' } }, 5, '720p', false), 0.6);
  assert.equal(estimateCost({ ...model, pricing_skus: { video_tokens: '0.000007' } }, 5, '720p', true), null);
});

async function waitForStatus(agent: ReturnType<typeof request.agent>, id: string, status: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const jobs = (await agent.get('/api/jobs')).body.jobs;
    const job = jobs.find((j: { id: string }) => j.id === id);
    if (job?.status === status) return job;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${status}`);
}
