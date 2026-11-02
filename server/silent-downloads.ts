import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runMediaCommand } from './media';
import { ApiError } from './openrouter';

interface SilentVideo { path: string; mime: string; extension: string }
const formats: Record<string, { extension: string; mime: string; format: string }> = {
  'video/webm': { extension: 'webm', mime: 'video/webm', format: 'webm' },
  'video/ogg': { extension: 'ogv', mime: 'video/ogg', format: 'ogg' },
  'video/quicktime': { extension: 'mov', mime: 'video/quicktime', format: 'mov' },
  'video/x-matroska': { extension: 'mkv', mime: 'video/x-matroska', format: 'matroska' },
};

export class SilentDownloads {
  private pending = new Map<string, { promise: Promise<SilentVideo>; controller: AbortController }>();
  private closed = false;
  constructor(private directory: string) {}
  prepare(jobId: string, index: number, source: string, mime: string): Promise<SilentVideo> {
    if (this.closed) return Promise.reject(new ApiError(503, 'Video downloads are shutting down. Please retry after restarting Frame.'));
    const key = `${jobId}:${index}`;
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = this.create(jobId, index, source, mime, controller.signal).finally(() => this.pending.delete(key));
    this.pending.set(key, { promise, controller });
    return promise;
  }
  private async create(jobId: string, index: number, source: string, mime: string, signal: AbortSignal): Promise<SilentVideo> {
    const original = await stat(source);
    const fingerprint = createHash('sha256').update(`${original.size}:${original.mtimeMs}:${original.ino}`).digest('hex').slice(0, 20);
    const container = formats[mime] ?? { extension: 'mp4', mime: 'video/mp4', format: 'mp4' };
    const directory = resolve(this.directory, jobId);
    const path = resolve(directory, `${index}-${fingerprint}-without-audio.${container.extension}`);
    signal.throwIfAborted();
    const cached = await stat(path).catch(() => null);
    if (cached?.isFile() && cached.size > 0) return { path, mime: container.mime, extension: container.extension };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.part`;
    try {
      signal.throwIfAborted();
      await writeFile(temporary, '', { mode: 0o600 }); await chmod(temporary, 0o600);
      await runMediaCommand(process.env.FFMPEG_PATH || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', source,
        '-map', '0:v:0', '-c:v', 'copy', '-an', '-sn', '-dn',
        ...(['mp4', 'mov'].includes(container.format) ? ['-movflags', '+faststart'] : []),
        '-f', container.format, temporary,
      ], { signal });
      signal.throwIfAborted();
      if (!(await stat(temporary)).size) throw new ApiError(422, 'The download without audio was empty. Please try again.');
      await rename(temporary, path);
      return { path, mime: container.mime, extension: container.extension };
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) throw new ApiError(503, 'Downloading without audio needs FFmpeg. Install FFmpeg, then try again.');
      if (error instanceof ApiError && error.status === 422) throw new ApiError(422, 'Could not remove audio from this clip. Try downloading the original video.');
      throw error;
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async remove(jobId: string) {
    const operations = [...this.pending.entries()].filter(([key]) => key.startsWith(`${jobId}:`)).map(([, operation]) => operation);
    operations.forEach(operation => operation.controller.abort());
    await Promise.allSettled(operations.map(operation => operation.promise));
    await rm(resolve(this.directory, jobId), { recursive: true, force: true });
  }
  async close() {
    this.closed = true;
    this.pending.forEach(operation => operation.controller.abort());
    await Promise.allSettled([...this.pending.values()].map(operation => operation.promise));
  }
}
