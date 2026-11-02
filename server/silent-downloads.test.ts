import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from './app';
import { Store, type StoredJob } from './store';

const execute = promisify(execFile);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let directory: string;
let store: Store;
let studio: ReturnType<typeof createApp>;
let cookie: string;
let job: StoredJob;
let original: Buffer;
let cachedPath: string;
const videoHash = async (path: string) => (await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', path, '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-hash', 'sha256', '-'])).stdout;
const probe = async (path: string) => JSON.parse((await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path])).stdout);

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'frame-silent-downloads-'));
  store = new Store(join(directory, 'data')); await store.init(); studio = createApp({ store });
  cookie = (await request(studio.app).get('/api/health')).headers['set-cookie'][0].split(';')[0];
  const source = join(directory, 'source.mp4');
  await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', source]);
  original = await readFile(source);
  job = { id: randomUUID(), owner: cookie.split('=')[1], upstreamId: 'offline-test-job', title: 'Saved clip with sound', status: 'completed', input: { model: 'test/video', prompt: 'A test clip', assets: [] }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), outputCount: 2, storage: { status: 'saved' }, outputs: [] };
  const first = join(store.outputs, `${job.id}-0.mp4`);
  await writeFile(first, original);
  const second = join(store.outputs, `${job.id}-1.mp4`);
  await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', source, '-map', '0:v:0', '-c:v', 'copy', '-an', second]);
  for (const [index, path] of [first, second].entries()) job.outputs!.push({ index, mime: 'video/mp4', size: (await stat(path)).size, savedAt: new Date().toISOString() });
  store.data.jobs.push(job); await store.save();
});
after(async () => { await studio.close(); await rm(directory, { recursive: true, force: true }); });

test('download without audio removes audio and preserves the video stream and archived original', async () => {
  const prepared = await request(studio.app).post(`/api/jobs/${job.id}/without-audio`).set('Cookie', cookie).send({ index: 0 }).expect(200);
  assert.equal(prepared.body.url, `/api/jobs/${job.id}/content?index=0&download=1&audio=0`);
  const response = await request(studio.app).get(prepared.body.url).set('Cookie', cookie).expect('Content-Type', /video\/mp4/).expect('Content-Disposition', /without-audio\.mp4/).expect(200);
  const downloaded = join(directory, 'download.mp4'); await writeFile(downloaded, response.body);
  const metadata = await probe(downloaded);
  assert.equal(metadata.streams.filter((stream: { codec_type: string }) => stream.codec_type === 'audio').length, 0);
  assert.equal(metadata.streams[0].width, 160); assert.equal(metadata.streams[0].height, 90);
  assert(Math.abs(Number(metadata.format.duration) - 1) < 0.1);
  assert.equal(await videoHash(downloaded), await videoHash(join(store.outputs, `${job.id}-0.mp4`)));
  const normal = await request(studio.app).get(`/api/jobs/${job.id}/content?download=1`).set('Cookie', cookie).expect(200);
  assert.equal(digest(normal.body), digest(original));
  assert((await probe(join(store.outputs, `${job.id}-0.mp4`))).streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio'));
  const folder = join(store.outputs, 'without-audio', job.id);
  const files = await readdir(folder); assert.equal(files.length, 1);
  cachedPath = join(folder, files[0]); assert.equal((await stat(cachedPath)).mode & 0o777, 0o600);
});

test('any output clip can be selected, including a clip that already has no audio', async () => {
  const result = await request(studio.app).post(`/api/jobs/${job.id}/without-audio`).set('Cookie', cookie).send({ index: 1 }).expect(200);
  const response = await request(studio.app).get(result.body.url).set('Cookie', cookie).expect('Content-Disposition', /-2-without-audio/).expect(200);
  const downloaded = join(directory, 'second-output.mp4'); await writeFile(downloaded, response.body);
  assert.equal((await probe(downloaded)).streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio'), false);
  assert.equal(await videoHash(downloaded), await videoHash(join(store.outputs, `${job.id}-1.mp4`)));
  await request(studio.app).post(`/api/jobs/${job.id}/without-audio`).set('Cookie', cookie).send({ index: 2 }).expect(400);
  await request(studio.app).get(`/api/jobs/${job.id}/content?audio=0&index=2`).set('Cookie', cookie).expect(400);
  await request(studio.app).post(`/api/jobs/${job.id}/without-audio`).send({}).expect(404);
  await request(studio.app).get(`/api/jobs/${job.id}/content?audio=0`).expect(404);
});

test('silent exports persist across restart and use the cache without FFmpeg or an API key', async () => {
  const modified = (await stat(cachedPath)).mtimeMs;
  await studio.close(); store = new Store(join(directory, 'data')); await store.init(); studio = createApp({ store });
  const previous = process.env.FFMPEG_PATH; process.env.FFMPEG_PATH = join(directory, 'not-installed-ffmpeg');
  try {
    await request(studio.app).post(`/api/jobs/${job.id}/without-audio`).set('Cookie', cookie).send({ index: 0 }).expect(200);
    await request(studio.app).get(`/api/jobs/${job.id}/content?audio=0`).set('Cookie', cookie).set('Range', 'bytes=0-15').expect(206);
    assert.equal((await stat(cachedPath)).mtimeMs, modified);
  } finally { if (previous === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous; }
});

test('missing FFmpeg is reported without losing the original or leaving an incomplete export', async () => {
  const fresh: StoredJob = { ...structuredClone(job), id: randomUUID(), outputs: [job.outputs![0]], outputCount: 1 };
  store.data.jobs.push(fresh); await writeFile(join(store.outputs, `${fresh.id}-0.mp4`), original); await store.save();
  const previous = process.env.FFMPEG_PATH; process.env.FFMPEG_PATH = join(directory, 'not-installed-ffmpeg');
  try {
    const failed = await request(studio.app).post(`/api/jobs/${fresh.id}/without-audio`).set('Cookie', cookie).send({ index: 0 }).expect(503);
    assert.match(failed.body.error, /needs FFmpeg/);
    assert.deepEqual(await readdir(join(store.outputs, 'without-audio', fresh.id)), []);
    assert.equal(digest(await readFile(join(store.outputs, `${fresh.id}-0.mp4`))), digest(original));
  } finally { if (previous === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous; }
  await request(studio.app).delete(`/api/jobs/${fresh.id}`).set('Cookie', cookie).expect(204);
});

test('WebM clips keep their container and video stream when audio is removed', async () => {
  const id = randomUUID(); const source = join(store.outputs, `${id}-0.mp4`);
  await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', join(directory, 'source.mp4'), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-f', 'webm', source]);
  const fresh: StoredJob = { ...structuredClone(job), id, outputCount: 1, outputs: [{ index: 0, mime: 'video/webm', size: (await stat(source)).size, savedAt: new Date().toISOString() }] };
  store.data.jobs.push(fresh); await store.save();
  const result = await request(studio.app).post(`/api/jobs/${id}/without-audio`).set('Cookie', cookie).send({ index: 0 }).expect(200);
  const downloaded = await request(studio.app).get(result.body.url).set('Cookie', cookie).expect('Content-Type', /video\/webm/).expect('Content-Disposition', /without-audio\.webm/).expect(200);
  const path = join(directory, 'download.webm'); await writeFile(path, downloaded.body);
  assert.equal((await probe(path)).streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio'), false);
  assert.equal(await videoHash(path), await videoHash(source));
  await request(studio.app).delete(`/api/jobs/${id}`).set('Cookie', cookie).expect(204);
});

test('removing a generation also removes its silent downloads', async () => {
  await request(studio.app).delete(`/api/jobs/${job.id}`).set('Cookie', cookie).expect(204);
  await assert.rejects(stat(cachedPath), { code: 'ENOENT' });
  await assert.rejects(stat(join(store.outputs, `${job.id}-0.mp4`)), { code: 'ENOENT' });
});
