import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { httpsOrigin, REFERENCE_PATH, ReferenceHost } from './reference-host';

test('isolated reference hosting serves only granted bytes and supports HEAD/ranges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frame-refs-'));
  const host = new ReferenceHost(join(directory, '.exports'), { publicOrigin: 'https://media.example' });
  try {
    const source = join(directory, 'input.mp4'); await writeFile(source, 'selected clip bytes');
    const reference = await host.publish({ path: source, mime: 'video/mp4', kind: 'video' });
    const app = express(); app.use(REFERENCE_PATH, host.router);
    const path = new URL(reference.url).pathname;
    await unlink(source);
    const result = await request(app).get(path).expect(200);
    assert.equal(result.headers['cache-control'], 'private, no-store');
    assert.equal(result.headers['set-cookie'], undefined);
    await request(app).head(path).expect(200);
    await request(app).get(path).set('Range', 'bytes=0-7').expect(206);
    await request(app).get('/api/connection').expect(404);
    await request(app).get('/api/assets').expect(404);
    await request(app).get('/').expect(404);
    await request(app).post(path).send({}).expect(404);
    await request(app).get(`${REFERENCE_PATH}/${'0'.repeat(64)}/input.mp4`).expect(404);
    await host.release([reference.id]);
    await request(app).get(path).expect(404);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('links expire and active generations can renew them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frame-ref-expiry-'));
  let now = Date.now();
  const host = new ReferenceHost(join(directory, 'exports'), { publicOrigin: 'https://media.example', now: () => now, lifetime: 1000 });
  try {
    const source = join(directory, 'audio.wav'); await writeFile(source, 'sound');
    const reference = await host.publish({ path: source, mime: 'audio/wav', kind: 'audio' });
    const app = express(); app.use(REFERENCE_PATH, host.router);
    const path = new URL(reference.url).pathname;
    now += 900; host.renew([reference.id]); now += 900;
    await request(app).get(path).expect(200);
    now += 101; await request(app).get(path).expect(404);
    assert.equal(await readFile(source, 'utf8'), 'sound');
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('reference origins reject HTTP and local/private addresses', () => {
  assert.equal(httpsOrigin('https://media.example/'), 'https://media.example');
  for (const url of ['http://media.example', 'https://localhost', 'https://127.0.0.1', 'https://192.168.1.2', 'https://media.example/path', 'https://key:secret@media.example', 'file:///tmp/video']) assert.throws(() => httpsOrigin(url));
});
