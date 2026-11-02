import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { Store } from './store';
import { createApp } from './app';

test('saved prompts preserve every revision, restore as a new revision, and persist across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frame-prompts-'));
  const store = new Store(directory); await store.init();
  const studio = createApp({ store });
  try {
    const agent = request.agent(studio.app);
    const first = (await agent.post('/api/prompts').send({ title: 'Morning forest', text: 'A quiet forest at sunrise.' }).expect(201)).body.prompt;
    assert.equal(first.version, 1); assert.equal(first.owner, undefined);
    const second = (await agent.put(`/api/prompts/${first.id}`).send({ title: first.title, text: 'A quiet forest at sunrise. Slow camera movement.', expectedVersion: 1 }).expect(200)).body.prompt;
    assert.equal(second.version, 2);
    const third = (await agent.put(`/api/prompts/${first.id}`).send({ title: 'Cinematic forest', text: 'Rain falls through the trees.', expectedVersion: 2 }).expect(200)).body.prompt;
    assert.equal(third.version, 3);
    const restored = (await agent.post(`/api/prompts/${first.id}/restore`).send({ version: 1, expectedVersion: 3 }).expect(200)).body;
    assert.equal(restored.prompt.version, 4);
    assert.equal(restored.prompt.text, first.text);
    assert.equal(restored.prompt.title, first.title);
    assert.equal(restored.versions.length, 4);
    assert.equal(restored.versions[0].restoredFrom, 1);
    assert.equal(restored.versions.find((version: { version: number }) => version.version === 3).text, third.text);
    const reloaded = new Store(directory); await reloaded.init();
    assert.equal(reloaded.data.prompts[0].version, 4);
    assert.equal(reloaded.data.prompts[0].versions.length, 4);
    const listed = (await agent.get('/api/prompts').expect(200)).body.prompts;
    assert.equal(listed[0].text, first.text); assert.equal(listed[0].versions, undefined);
  } finally { await studio.close(); await rm(directory, { recursive: true, force: true }); }
});

test('prompt ownership and optimistic locking protect history from other sessions and stale writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frame-prompt-access-'));
  const store = new Store(directory); await store.init();
  const studio = createApp({ store });
  try {
    const agent = request.agent(studio.app);
    const body = { title: 'The coast', text: 'Waves roll toward the shore.' };
    const prompt = (await agent.post('/api/prompts').send(body)).body.prompt;
    await agent.put(`/api/prompts/${prompt.id}`).send({ ...body, expectedVersion: 1 }).expect(200);
    assert.equal(store.data.prompts[0].versions.length, 1, 'an unchanged save does not create a duplicate revision');
    await agent.put(`/api/prompts/${prompt.id}`).send({ ...body, text: 'Golden light over the sea.', expectedVersion: 1 }).expect(200);
    await agent.put(`/api/prompts/${prompt.id}`).send({ ...body, expectedVersion: 1 }).expect(409);
    await agent.post(`/api/prompts/${prompt.id}/restore`).send({ version: 1, expectedVersion: 1 }).expect(409);
    assert.equal(store.data.prompts[0].version, 2);
    assert.deepEqual((await request(studio.app).get('/api/prompts')).body.prompts, []);
    await request(studio.app).get(`/api/prompts/${prompt.id}`).expect(404);
    await request(studio.app).delete(`/api/prompts/${prompt.id}`).expect(404);
    await request(studio.app).post(`/api/prompts/${prompt.id}/restore`).send({ version: 1, expectedVersion: 2 }).expect(404);
    await agent.post('/api/prompts').send({ title: 'Empty', text: ' ' }).expect(400);
    await agent.delete(`/api/prompts/${prompt.id}`).expect(204);
    await agent.get(`/api/prompts/${prompt.id}`).expect(404);
  } finally { await studio.close(); await rm(directory, { recursive: true, force: true }); }
});

test('existing workspaces without a prompt collection load without losing assets or jobs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frame-prompt-migration-'));
  try {
    await writeFile(join(directory, 'studio.json'), JSON.stringify({ assets: [], jobs: [] }));
    const store = new Store(directory); await store.init();
    assert.deepEqual(store.data, { assets: [], jobs: [], prompts: [] });
    await store.save();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
