import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './openrouter';
import { Store, type StoredPrompt } from './store';

const content = z.object({ title: z.string().trim().min(1).max(120), text: z.string().min(1).max(10_000).refine(text => !!text.trim(), 'Write a prompt before saving.') });
const update = content.extend({ expectedVersion: z.number().int().positive() });
const publicPrompt = ({ owner: _owner, versions: _versions, ...prompt }: StoredPrompt) => prompt;

export function promptRoutes(store: Store) {
  const router = Router();
  function find(id: string, owner: string) {
    const prompt = store.data.prompts.find(prompt => prompt.id === id && prompt.owner === owner);
    if (!prompt) throw new ApiError(404, 'Saved prompt not found.');
    return prompt;
  }
  function checkVersion(prompt: StoredPrompt, expected: number) {
    if (prompt.version !== expected) throw new ApiError(409, 'This prompt changed in another tab. Reopen it from Saved prompts before saving; your draft is still here.');
  }
  router.get('/', (req, res) => { res.json({ prompts: store.data.prompts.filter(prompt => prompt.owner === req.studioOwner).map(publicPrompt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }); });
  router.post('/', async (req, res) => {
    const input = content.parse(req.body);
    const now = new Date().toISOString();
    const prompt: StoredPrompt = { ...input, id: randomUUID(), owner: req.studioOwner, version: 1, createdAt: now, updatedAt: now, versions: [{ ...input, version: 1, createdAt: now }] };
    store.data.prompts.push(prompt); await store.save();
    res.status(201).json({ prompt: publicPrompt(prompt) });
  });
  router.get('/:id', (req, res) => {
    const prompt = find(String(req.params.id), req.studioOwner);
    res.json({ prompt: publicPrompt(prompt), versions: [...prompt.versions].reverse() });
  });
  router.put('/:id', async (req, res) => {
    const { expectedVersion, ...input } = update.parse(req.body);
    const prompt = find(String(req.params.id), req.studioOwner);
    checkVersion(prompt, expectedVersion);
    if (prompt.title !== input.title || prompt.text !== input.text) {
      Object.assign(prompt, input, { version: prompt.version + 1, updatedAt: new Date().toISOString() });
      prompt.versions.push({ ...input, version: prompt.version, createdAt: prompt.updatedAt });
      await store.save();
    }
    res.json({ prompt: publicPrompt(prompt) });
  });
  router.post('/:id/restore', async (req, res) => {
    const input = z.object({ version: z.number().int().positive(), expectedVersion: z.number().int().positive() }).parse(req.body);
    const prompt = find(String(req.params.id), req.studioOwner);
    checkVersion(prompt, input.expectedVersion);
    const version = prompt.versions.find(version => version.version === input.version);
    if (!version) throw new ApiError(404, 'That prompt version was not found.');
    if (input.version !== prompt.version) {
      prompt.title = version.title; prompt.text = version.text; prompt.version++; prompt.updatedAt = new Date().toISOString();
      prompt.versions.push({ title: prompt.title, text: prompt.text, version: prompt.version, createdAt: prompt.updatedAt, restoredFrom: input.version });
      await store.save();
    }
    res.json({ prompt: publicPrompt(prompt), versions: [...prompt.versions].reverse() });
  });
  router.delete('/:id', async (req, res) => {
    const prompt = find(String(req.params.id), req.studioOwner);
    store.data.prompts = store.data.prompts.filter(item => item !== prompt);
    await store.save(); res.status(204).end();
  });
  return router;
}
