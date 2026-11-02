import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { terminalStatuses, type Asset, type PreparedAsset, type PromptVersion, type SavedPrompt, type VideoJob } from '../shared/types';
import { Connections } from './connections';

export type StoredAsset = Asset & { owner: string; filename: string; versions?: (PreparedAsset & { filename: string })[] };
export type StoredJob = VideoJob & { owner: string };
export type StoredPrompt = SavedPrompt & { owner: string; versions: PromptVersion[] };
interface Database { assets: StoredAsset[]; jobs: StoredJob[]; prompts: StoredPrompt[] }

export class Store {
  data: Database = { assets: [], jobs: [], prompts: [] };
  private writes: Promise<void> = Promise.resolve();
  readonly uploads: string;
  readonly prepared: string;
  readonly outputs: string;
  readonly connections: Connections;
  constructor(readonly directory: string) { this.uploads = resolve(directory, 'uploads'); this.prepared = resolve(directory, 'prepared'); this.outputs = resolve(directory, 'outputs'); this.connections = new Connections(directory); }
  async init() {
    await mkdir(this.uploads, { recursive: true });
    await mkdir(this.prepared, { recursive: true });
    await mkdir(this.outputs, { recursive: true, mode: 0o700 });
    await this.connections.init();
    try { this.data = { prompts: [], ...JSON.parse(await readFile(resolve(this.directory, 'studio.json'), 'utf8')) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const prompt of this.data.prompts) {
      prompt.assets ??= [];
      for (const version of prompt.versions) version.assets ??= [];
    }
    for (const asset of this.data.assets) {
      if (asset.preparation && ['queued', 'processing'].includes(asset.preparation.status)) {
        asset.preparation.status = 'failed';
        asset.preparation.error = 'Preparation was interrupted. Your original and previous input are unchanged. Please save again.';
      }
    }
    for (const job of this.data.jobs) {
      if (job.storage?.status === 'saving') job.storage = { status: 'pending' };
      if (terminalStatuses.includes(job.status) && !job.finishedAt && Number.isFinite(Date.parse(job.updatedAt)) && Number.isFinite(Date.parse(job.createdAt))) {
        job.finishedAt = job.updatedAt;
        job.generationTimeMs = Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.createdAt));
      }
      if (job.status === 'completed') job.outputCount = Math.max(1, job.outputCount);
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
