import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Asset, PreparedAsset, PromptVersion, SavedPrompt, VideoJob } from '../shared/types';

export type StoredAsset = Asset & { owner: string; filename: string; versions?: (PreparedAsset & { filename: string })[] };
export type StoredJob = VideoJob & { owner: string };
export type StoredPrompt = SavedPrompt & { owner: string; versions: PromptVersion[] };
interface Database { assets: StoredAsset[]; jobs: StoredJob[]; prompts: StoredPrompt[] }

export class Store {
  data: Database = { assets: [], jobs: [], prompts: [] };
  private writes: Promise<void> = Promise.resolve();
  readonly uploads: string;
  readonly prepared: string;
  constructor(readonly directory: string) { this.uploads = resolve(directory, 'uploads'); this.prepared = resolve(directory, 'prepared'); }
  async init() {
    await mkdir(this.uploads, { recursive: true });
    await mkdir(this.prepared, { recursive: true });
    try { this.data = { prompts: [], ...JSON.parse(await readFile(resolve(this.directory, 'studio.json'), 'utf8')) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const asset of this.data.assets) {
      if (asset.preparation && ['queued', 'processing'].includes(asset.preparation.status)) {
        asset.preparation.status = 'failed';
        asset.preparation.error = 'Preparation was interrupted. Your original and previous input are unchanged. Please save again.';
      }
    }
  }
  save() {
    // Serialize snapshots and atomically replace the file, including under concurrent polls.
    const snapshot = JSON.stringify(this.data);
    const operation = this.writes.then(async () => {
      const temporary = resolve(this.directory, 'studio.json.tmp');
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, resolve(this.directory, 'studio.json'));
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
}

export function publicAsset({ owner: _owner, filename: _filename, versions: _versions, ...asset }: StoredAsset): Asset { return asset; }
export function publicJob({ owner: _owner, ...job }: StoredJob): VideoJob { return job; }
