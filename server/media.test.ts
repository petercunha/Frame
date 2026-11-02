import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import type { Asset } from '../shared/types';
import { createApp } from './app';
import { OpenRouter } from './openrouter';
import { Store } from './store';

const execute = promisify(execFile);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let directory: string;
let store: Store;
let studio: ReturnType<typeof createApp>;
let picture: Buffer;
let submitted: Record<string, unknown>;
const videoPath = () => join(directory, 'source.mp4');
const audioPath = () => join(directory, 'source.wav');

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'frame-media-'));
  store = new Store(join(directory, '.library')); await store.init();
  // Solid-color test fixtures make crop location observable without external assets.
  const left = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();
  picture = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#0000ff' } }).composite([{ input: left, left: 0, top: 0 }]).png().toBuffer();
  await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=20', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', videoPath()]);
  await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'pcm_s16le', audioPath()]);
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/videos/models')) return Response.json({ data: [{ id: 'test/video', name: 'Test model', description: '', supported_frame_images: ['first_frame'], supported_durations: [5] }] });
    if (init?.method === 'POST') { submitted = JSON.parse(String(init.body)); return Response.json({ id: 'test-job', status: 'completed', unsigned_urls: ['clip'] }, { status: 202 }); }
    return Response.json({});
  };
  studio = createApp({ store, router: new OpenRouter('https://test.invalid', fetcher), apiKey: 'local-test-only' });
});
after(async () => { studio.close(); await rm(directory, { recursive: true, force: true }); });

test('image preparation crops the selected pixels, downsizes, and preserves the original byte for byte', async () => {
  const agent = request.agent(studio.app);
  const original = (await agent.post('/api/assets').attach('files', picture, 'color-study.png').expect(201)).body.assets[0] as Asset;
  const opened = (await agent.get(`/api/assets/${original.id}/editor`).expect(200)).body.asset;
  assert.equal(opened.metadata.width, 400); assert.equal(opened.metadata.height, 200);
  await agent.post(`/api/assets/${original.id}/prepare`).send({ crop: { x: 0, y: 0, width: 0.5, height: 1 }, maxWidth: 120, maxHeight: 120 }).expect(202);
  const asset = await prepared(agent, original.id);
  assert.equal(asset.prepared!.metadata.width, 120); assert.equal(asset.prepared!.metadata.height, 120);
  const response = await agent.get(asset.prepared!.url).expect(200);
  const pixel = await sharp(response.body).raw().toBuffer();
  assert.equal(pixel[0], 255); assert.equal(pixel[2], 0, 'the red left half, rather than the blue right half, was cropped');
  const originalResponse = await agent.get(original.url).expect(200);
  assert.equal(digest(originalResponse.body), digest(picture));
  assert.equal(asset.size, picture.length);
  assert.equal((asset as unknown as Record<string, unknown>).versions, undefined);
  await request(studio.app).get(asset.prepared!.url).expect(404);
  await request(studio.app).post(`/api/assets/${original.id}/prepare`).send({}).expect(404);
});

test('video preparation seeks, trims, crops, caps dimensions, and optionally removes sound', async () => {
  const agent = request.agent(studio.app);
  const source = await readFile(videoPath());
  const original = (await agent.post('/api/assets').attach('files', source, 'long-take.mp4').expect(201)).body.assets[0] as Asset;
  await agent.post(`/api/assets/${original.id}/prepare`).send({ start: 1.1, end: 2.35, crop: { x: 0.25, y: 0, width: 0.5, height: 1 }, maxWidth: 80, maxHeight: 80, mute: true }).expect(202);
  const asset = await prepared(agent, original.id);
  assert.deepEqual([asset.prepared!.metadata.width, asset.prepared!.metadata.height], [70, 80]);
  assert(Math.abs(asset.prepared!.metadata.duration! - 1.25) < 0.12);
  assert.equal(asset.prepared!.metadata.hasAudio, false);
  const stored = store.data.assets.find(a => a.id === asset.id)!;
  assert.equal(digest(await readFile(join(store.uploads, stored.filename))), digest(source));
  await agent.get(asset.prepared!.url).set('Range', 'bytes=0-19').expect(206);
  await agent.post(`/api/assets/${asset.id}/prepare`).send({ start: 0, end: 0.5, maxWidth: 1280, maxHeight: 1280, mute: false }).expect(202);
  const second = await prepared(agent, asset.id);
  assert.deepEqual([second.prepared!.metadata.width, second.prepared!.metadata.height], [320, 180], 'small sources are never enlarged');
  assert.equal(second.prepared!.metadata.hasAudio, true);
});

test('audio trimming produces the selected duration without altering the source', async () => {
  const agent = request.agent(studio.app);
  const source = await readFile(audioPath());
  const original = (await agent.post('/api/assets').attach('files', source, 'ambience.wav').expect(201)).body.assets[0] as Asset;
  await agent.post(`/api/assets/${original.id}/prepare`).send({ start: 0.4, end: 1.3 }).expect(202);
  const asset = await prepared(agent, original.id);
  assert.equal(asset.prepared!.mime, 'audio/wav');
  assert(Math.abs(asset.prepared!.metadata.duration! - 0.9) < 0.02);
  assert(asset.prepared!.size < original.size);
  const stored = store.data.assets.find(a => a.id === asset.id)!;
  assert.equal(digest(await readFile(join(store.uploads, stored.filename))), digest(source));
});

test('EXIF-oriented images are cropped in the same orientation shown by the browser', async () => {
  const agent = request.agent(studio.app);
  const source = await sharp(picture).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const original = (await agent.post('/api/assets').attach('files', source, 'portrait.jpg')).body.assets[0] as Asset;
  const opened = (await agent.get(`/api/assets/${original.id}/editor`)).body.asset as Asset;
  assert.deepEqual([opened.metadata!.width, opened.metadata!.height], [200, 400]);
  await agent.post(`/api/assets/${original.id}/prepare`).send({ crop: { x: 0, y: 0, width: 0.5, height: 1 }, maxWidth: 200, maxHeight: 200 }).expect(202);
  const asset = await prepared(agent, original.id);
  assert.deepEqual([asset.prepared!.metadata.width, asset.prepared!.metadata.height], [50, 200]);
});

test('rotated video sources use display coordinates and export with the expected orientation', async () => {
  const rotated = join(directory, 'rotated.mp4');
  await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-display_rotation:v:0', '90', '-i', videoPath(), '-c', 'copy', rotated]);
  const agent = request.agent(studio.app);
  const original = (await agent.post('/api/assets').attach('files', await readFile(rotated), 'portrait-video.mp4')).body.assets[0] as Asset;
  const opened = (await agent.get(`/api/assets/${original.id}/editor`)).body.asset as Asset;
  assert.deepEqual([opened.metadata!.width, opened.metadata!.height], [180, 320]);
  await agent.post(`/api/assets/${original.id}/prepare`).send({ start: 1, end: 2, crop: { x: 0, y: 0, width: 1, height: 0.5 }, maxWidth: 64, maxHeight: 64 }).expect(202);
  const asset = await prepared(agent, original.id);
  assert.deepEqual([asset.prepared!.metadata.width, asset.prepared!.metadata.height], [64, 56]);
});

test('a processing failure keeps the previous prepared input usable', async () => {
  const agent = request.agent(studio.app);
  const original = (await agent.post('/api/assets').attach('files', await readFile(audioPath()), 'retry.wav')).body.assets[0] as Asset;
  await agent.post(`/api/assets/${original.id}/prepare`).send({ start: 0, end: 1 }).expect(202);
  const first = await prepared(agent, original.id);
  const previousPath = process.env.FFMPEG_PATH;
  try {
    process.env.FFMPEG_PATH = join(directory, 'missing-ffmpeg');
    await agent.post(`/api/assets/${original.id}/prepare`).send({ start: 1, end: 2 }).expect(202);
    const deadline = Date.now() + 3000;
    let asset: Asset;
    do {
      asset = (await agent.get(`/api/assets/${original.id}/editor`)).body.asset as Asset;
      if (asset.preparation?.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal(asset.preparation?.status, 'failed');
    assert.equal(asset.prepared!.id, first.prepared!.id);
    await agent.get(first.prepared!.url).expect(200);
  } finally {
    if (previousPath === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousPath;
  }
});

test('large lossless originals upload successfully; generation limits apply to prepared inputs', async () => {
  const agent = request.agent(studio.app);
  const large = Buffer.concat([picture, Buffer.alloc(26 * 1024 * 1024)]);
  const original = (await agent.post('/api/assets').attach('files', large, 'large-original.png').expect(201)).body.assets[0] as Asset;
  const input = { model: 'test/video', prompt: 'Use the reference', duration: 5, assets: [{ id: original.id, role: 'reference' }] };
  await agent.post('/api/jobs').send(input).expect(413);
  await agent.post(`/api/assets/${original.id}/prepare`).send({ maxWidth: 80, maxHeight: 80 }).expect(202);
  const asset = await prepared(agent, original.id);
  const job = await agent.post('/api/jobs').send(input).expect(202);
  assert.equal(job.body.job.input.assets[0].preparedId, asset.prepared!.id);
  const dataUrl = (submitted.input_references as { image_url: { url: string } }[])[0].image_url.url;
  const encodedBytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.equal(encodedBytes.length, asset.prepared!.size);
  assert(encodedBytes.length < 100_000);
  const stored = store.data.assets.find(a => a.id === asset.id)!;
  assert.equal((await stat(join(store.uploads, stored.filename))).size, large.length);
});

test('input versions remain stable during subsequent edits, persist, and can be restored', async () => {
  const agent = request.agent(studio.app);
  const original = (await agent.post('/api/assets').attach('files', picture, 'versions.png')).body.assets[0] as Asset;
  await agent.post(`/api/assets/${original.id}/prepare`).send({ maxWidth: 100, maxHeight: 100 });
  const first = await prepared(agent, original.id);
  await agent.post(`/api/assets/${original.id}/prepare`).send({ maxWidth: 40, maxHeight: 40 });
  const second = await prepared(agent, original.id);
  assert.notEqual(first.prepared!.id, second.prepared!.id);
  await agent.post('/api/jobs').send({ model: 'test/video', prompt: 'Earlier input', assets: [{ id: original.id, role: 'reference', preparedId: first.prepared!.id }] }).expect(202);
  const earlier = Buffer.from((submitted.input_references as { image_url: { url: string } }[])[0].image_url.url.split(',')[1], 'base64');
  assert.equal((await sharp(earlier).metadata()).width, 100);
  const reloaded = new Store(store.directory); await reloaded.init();
  assert.equal(reloaded.data.assets.find(a => a.id === original.id)!.prepared!.id, second.prepared!.id);
  assert.equal(reloaded.data.assets.find(a => a.id === original.id)!.versions!.length, 2);
  const restored = await agent.delete(`/api/assets/${original.id}/prepared`).expect(200);
  assert.equal(restored.body.asset.prepared, undefined);
  await agent.get(first.prepared!.url).expect(200);
  await agent.delete(`/api/assets/${original.id}`).expect(204);
  await agent.get(first.prepared!.url).expect(404);
});

test('invalid trim/crop requests fail before processing and preserve the previous input', async () => {
  const agent = request.agent(studio.app);
  const image = (await agent.post('/api/assets').attach('files', picture, 'validation.png')).body.assets[0] as Asset;
  await agent.post(`/api/assets/${image.id}/prepare`).send({ maxWidth: 64 });
  const saved = await prepared(agent, image.id);
  for (const edits of [{ crop: { x: 0.9, y: 0, width: 0.5, height: 1 } }, { maxWidth: -1 }, { start: 1 }, { crop: { x: 0, y: 0, width: 0, height: 1 } }]) {
    await agent.post(`/api/assets/${image.id}/prepare`).send(edits).expect(400);
  }
  const after = (await agent.get(`/api/assets/${image.id}/editor`)).body.asset as Asset;
  assert.equal(after.prepared!.id, saved.prepared!.id);
  const audio = (await agent.post('/api/assets').attach('files', await readFile(audioPath()), 'invalid-trim.wav')).body.assets[0] as Asset;
  for (const edits of [{ start: 2, end: 1 }, { start: 1, end: 100 }, { crop: { x: 0, y: 0, width: 1, height: 1 } }]) {
    await agent.post(`/api/assets/${audio.id}/prepare`).send(edits).expect(400);
  }
});

test('an interrupted preparation is recovered on restart without losing the original or last good input', async () => {
  const copyDirectory = join(directory, 'recovery');
  const originalStore = new Store(copyDirectory); await originalStore.init();
  originalStore.data.assets.push({ id: 'interrupted', owner: 'owner', filename: 'original', name: 'original.png', kind: 'image', mime: 'image/png', size: 1, url: '', createdAt: '', preparation: { id: 'task', status: 'processing', progress: 0.4 } });
  await writeFile(join(originalStore.uploads, 'original'), 'unchanged');
  await originalStore.save();
  const recovered = new Store(copyDirectory); await recovered.init();
  assert.equal(recovered.data.assets[0].preparation!.status, 'failed');
  assert.match(recovered.data.assets[0].preparation!.error!, /interrupted/);
  assert.equal(await readFile(join(recovered.uploads, 'original'), 'utf8'), 'unchanged');
});

async function prepared(agent: ReturnType<typeof request.agent>, id: string): Promise<Asset> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const asset = (await agent.get(`/api/assets/${id}/editor`).expect(200)).body.asset as Asset;
    if (asset.preparation?.status === 'failed') throw new Error(asset.preparation.error);
    if (asset.preparation?.status === 'completed') return asset;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Preparation timed out');
}
