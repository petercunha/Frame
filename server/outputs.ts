import { createWriteStream } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from './openrouter';
import type { Store, StoredJob } from './store';

type Download = (job: StoredJob, index: number, signal: AbortSignal) => Promise<Response>;
type Work = { job: StoredJob; controller: AbortController; resolve: () => void; reject: (error: unknown) => void };

export class OutputArchive {
  private pending = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private failures = new Map<string, number>();
  private queue: Work[] = [];
  private active = 0;
  private closed = false;
  constructor(private store: Store, private download: Download, private retryDelay = 5000) {}
  path(job: StoredJob, index: number) { return resolve(this.store.outputs, `${job.id}-${index}.mp4`); }
  schedule(job: StoredJob, delay = 0) {
    if (this.closed || job.status !== 'completed' || this.pending.has(job.id) || this.timers.has(job.id)) return;
    const timer = setTimeout(() => { this.timers.delete(job.id); void this.ensure(job).catch(() => {}); }, delay);
    timer.unref(); this.timers.set(job.id, timer);
  }
  ensure(job: StoredJob): Promise<void> {
    if (this.closed || job.status !== 'completed' || !this.store.data.jobs.includes(job)) return Promise.reject(new ApiError(409, 'This generation is not available for local saving.'));
    const existing = this.pending.get(job.id);
    if (existing) return existing;
    clearTimeout(this.timers.get(job.id)); this.timers.delete(job.id);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    let work: Work;
    const operation = new Promise<void>((resolve, reject) => { work = { job, controller, resolve, reject }; });
    this.pending.set(job.id, operation);
    this.queue.push(work!); this.pump();
    return operation;
  }
  private pump() {
    while (!this.closed && this.active < 2 && this.queue.length) {
      const work = this.queue.shift()!;
      this.active++;
      void this.save(work.job, work.controller.signal).then(work.resolve, work.reject).finally(() => {
        this.active--; this.pending.delete(work.job.id); this.controllers.delete(work.job.id); this.pump();
      });
    }
  }
  private async save(job: StoredJob, signal: AbortSignal) {
    job.storage = { status: 'saving' };
    try {
      await this.store.save();
      job.outputs ??= [];
      for (let index = 0; index < job.outputCount; index++) {
        signal.throwIfAborted();
        const path = this.path(job, index);
        const previous = job.outputs.find(output => output.index === index);
        const file = await stat(path).catch(() => null);
        if (file?.isFile() && file.size > 0 && (!previous || previous.size === file.size)) {
          // A final file can survive a crash between atomic rename and metadata save.
          if (!previous) job.outputs.push({ index, mime: 'video/mp4', size: file.size, savedAt: file.mtime.toISOString() });
          continue;
        }
        const temporary = `${path}.part`;
        try {
          const response = await this.download(job, index, signal);
          signal.throwIfAborted();
          if (response.status !== 200 || !response.body) throw new Error('Incomplete video response');
          const mime = response.headers.get('content-type')?.split(';')[0] ?? 'video/mp4';
          if (!mime.startsWith('video/') && mime !== 'application/octet-stream') throw new Error('Invalid video response');
          await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary, { mode: 0o600 }), { signal });
          const size = (await stat(temporary)).size;
          const length = response.headers.get('content-length');
          if (!size || (length !== null && !response.headers.has('content-encoding') && Number(length) !== size)) throw new Error('Incomplete video download');
          signal.throwIfAborted();
          await rename(temporary, path);
          job.outputs = job.outputs.filter(output => output.index !== index);
          job.outputs.push({ index, mime: mime === 'application/octet-stream' ? 'video/mp4' : mime, size, savedAt: new Date().toISOString() });
          await this.store.save();
        } finally { await unlink(temporary).catch(() => {}); }
      }
      signal.throwIfAborted();
      job.storage = { status: 'saved' }; this.failures.delete(job.id);
      await this.store.save();
    } catch (error) {
      if (!signal.aborted) {
        job.storage = { status: 'failed', error: 'The video is ready, but its local copy could not be saved. Frame will retry the download without generating again.' };
        const failures = (this.failures.get(job.id) ?? 0) + 1; this.failures.set(job.id, failures);
        await this.store.save().catch(() => {});
        // Schedule after the current operation is removed from the pending map.
        const timer = setTimeout(() => { this.timers.delete(job.id); this.schedule(job); }, Math.min(this.retryDelay * 2 ** Math.min(failures - 1, 4), 60_000));
        timer.unref(); this.timers.set(job.id, timer);
      }
      throw signal.aborted ? error : new ApiError(502, job.storage?.error ?? 'Could not save this video locally.');
    }
  }
  async remove(job: StoredJob) {
    clearTimeout(this.timers.get(job.id)); this.timers.delete(job.id);
    this.controllers.get(job.id)?.abort();
    await this.pending.get(job.id)?.catch(() => {});
    await Promise.all(Array.from({ length: job.outputCount }, (_, index) => unlink(this.path(job, index)).catch(() => {})));
    this.failures.delete(job.id);
  }
  async close() {
    this.closed = true;
    this.timers.forEach(clearTimeout); this.timers.clear();
    this.controllers.forEach(controller => controller.abort());
    for (const work of this.queue.splice(0)) { work.reject(new Error('Local saving stopped')); this.pending.delete(work.job.id); }
    await Promise.allSettled(this.pending.values());
    this.pending.clear(); this.controllers.clear();
  }
}
