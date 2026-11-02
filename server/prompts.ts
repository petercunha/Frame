import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './openrouter';
import { publicAsset, Store, type StoredPrompt } from './store';
import type { PromptAsset } from '../shared/types';

const selections = z.array(z.object({ id: z.uuid(), role: z.enum(['reference', 'first_frame', 'last_frame']), preparedId: z.uuid().nullable().optional() })).max(12);
const content = z.object({ title: z.string().trim().min(1).max(120), text: z.string().min(1).max(10_000).refine(text => !!text.trim(), 'Write a prompt before saving.'), assets: selections.optional() });
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
  function captureReferences(input: z.infer<typeof selections>, owner: string): PromptAsset[] {
    const seen = new Set<string>();
    if (input.some(item => item.role === 'reference') && input.some(item => item.role !== 'reference')) throw new ApiError(400, 'Save frame images or reference assets in one prompt, rather than mixing these modes.');
    return input.map(selection => {
      const asset = store.data.assets.find(asset => asset.id === selection.id && asset.owner === owner);
      if (!asset) throw new ApiError(400, 'A reference asset is missing from your library. Remove or replace it before saving.');
      if (seen.has(asset.id) || (selection.role !== 'reference' && seen.has(selection.role))) throw new ApiError(400, 'Use each asset once, with one image per frame.');
      seen.add(asset.id); if (selection.role !== 'reference') seen.add(selection.role);
      if (selection.role !== 'reference' && asset.kind !== 'image') throw new ApiError(400, 'Frame references must be images.');
      if (asset.preparation && ['queued', 'processing'].includes(asset.preparation.status)) throw new ApiError(409, 'Wait for reference preparation to finish before saving this prompt.');
      const preparedId = selection.preparedId === undefined ? asset.prepared?.id ?? null : selection.preparedId;
      const version = preparedId ? asset.versions?.find(version => version.id === preparedId) : undefined;
      if (preparedId && !version) throw new ApiError(400, 'A saved input version is no longer available. Reattach that reference before saving.');
      const snapshot = publicAsset(asset);
      delete snapshot.preparation;
      if (version) { const { filename: _filename, ...prepared } = version; snapshot.prepared = prepared; }
      else delete snapshot.prepared;
      return { id: asset.id, role: selection.role, preparedId, snapshot: structuredClone(snapshot) };
    });
  }
  const referenceIdentity = (assets: PromptAsset[]) => JSON.stringify(assets.map(({ id, role, preparedId }) => ({ id, role, preparedId })));
  router.get('/', (req, res) => { res.json({ prompts: store.data.prompts.filter(prompt => prompt.owner === req.studioOwner).map(publicPrompt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }); });
  router.post('/', async (req, res) => {
    const input = content.parse(req.body);
    const assets = captureReferences(input.assets ?? [], req.studioOwner);
    const now = new Date().toISOString();
    const prompt: StoredPrompt = { title: input.title, text: input.text, assets, id: randomUUID(), owner: req.studioOwner, version: 1, createdAt: now, updatedAt: now, versions: [{ title: input.title, text: input.text, assets: structuredClone(assets), version: 1, createdAt: now }] };
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
    const assets = input.assets === undefined ? prompt.assets : captureReferences(input.assets, req.studioOwner);
    if (prompt.title !== input.title || prompt.text !== input.text || referenceIdentity(prompt.assets) !== referenceIdentity(assets)) {
      Object.assign(prompt, { title: input.title, text: input.text, assets, version: prompt.version + 1, updatedAt: new Date().toISOString() });
      prompt.versions.push({ title: prompt.title, text: prompt.text, assets: structuredClone(assets), version: prompt.version, createdAt: prompt.updatedAt });
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
      prompt.assets = structuredClone(version.assets);
      prompt.versions.push({ title: prompt.title, text: prompt.text, assets: structuredClone(prompt.assets), version: prompt.version, createdAt: prompt.updatedAt, restoredFrom: input.version });
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
