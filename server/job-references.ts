import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { GenerationInput, PromptAsset } from '../shared/types';
import { referenceFile } from './generation';
import { publicAsset, type Store, type StoredAsset, type StoredJob } from './store';

export function captureJobReferences(input: GenerationInput, assets: StoredAsset[]): PromptAsset[] {
  return input.assets.map(selection => {
    const asset = assets.find(asset => asset.id === selection.id)!;
    const preparedId = selection.preparedId === undefined ? asset.prepared?.id ?? null : selection.preparedId;
    const snapshot = structuredClone(publicAsset(asset));
    delete snapshot.preparation;
    const version = preparedId ? asset.versions?.find(version => version.id === preparedId) : undefined;
    if (version) { const { filename: _filename, ...prepared } = version; snapshot.prepared = structuredClone(prepared); }
    else delete snapshot.prepared;
    return { id: asset.id, role: selection.role, preparedId, snapshot };
  });
}

export async function reusableJob(store: Store, job: StoredJob) {
  const assets = store.data.assets.filter(asset => asset.owner === job.owner);
  const references: PromptAsset[] = [];
  for (const selection of job.input.assets) {
    const asset = assets.find(asset => asset.id === selection.id);
    if (!asset) continue;
    try {
      const file = referenceFile(asset, selection.preparedId);
      await access(resolve(file.prepared ? store.prepared : store.uploads, file.filename));
      const saved = job.references?.find(reference => reference.id === selection.id && reference.role === selection.role);
      references.push(structuredClone(saved ?? captureJobReferences({ ...job.input, assets: [selection] }, assets)[0]));
    } catch { /* Deleted original or prepared version: report it as unavailable. */ }
  }
  return {
    input: { ...job.input, apiProvider: job.apiProvider ?? 'openrouter', assets: references.map(({ id, role, preparedId }) => ({ id, role, preparedId })) },
    references, unavailableReferences: job.input.assets.length - references.length,
  };
}
