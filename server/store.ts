import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Asset, VideoJob } from '../shared/types';

export type StoredAsset = Asset & { owner: string; filename: string };
export type StoredJob = VideoJob & { owner: string };
interface Database { assets: StoredAsset[]; jobs: StoredJob[] }

export class Store {
  data: Database = { assets: [], jobs: [] };
  private writes: Promise<void> = Promise.resolve();
  readonly uploads: string;
  constructor(readonly directory: string) { this.uploads = resolve(directory, 'uploads'); }
  async init() {
    await mkdir(this.uploads, { recursive: true });
    try { this.data = JSON.parse(await readFile(resolve(this.directory, 'studio.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
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

export function publicAsset({ owner: _owner, filename: _filename, ...asset }: StoredAsset): Asset { return asset; }
export function publicJob({ owner: _owner, ...job }: StoredJob): VideoJob { return job; }
