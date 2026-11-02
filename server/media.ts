import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { MAX_REFERENCE_BYTES, preparedDimensions, type AssetEdits, type MediaMetadata } from '../shared/types';
import { ApiError } from './openrouter';
import { Store, type StoredAsset } from './store';

export const editsSchema = z.object({
  crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().gt(0).max(1), height: z.number().gt(0).max(1) }).nullable().optional(),
  maxWidth: z.number().int().min(16).max(16384).optional(),
  maxHeight: z.number().int().min(16).max(16384).optional(),
  start: z.number().min(0).optional(), end: z.number().positive().optional(), mute: z.boolean().optional(),
}).strict();

export function validateEdits(edits: AssetEdits, asset: StoredAsset) {
  const metadata = asset.metadata!;
  if (asset.kind === 'audio' && (edits.crop || edits.maxWidth || edits.maxHeight || edits.mute)) throw new ApiError(400, 'Audio files support trimming. Crop and size controls are for images and videos.');
  if (asset.kind === 'image' && (edits.start !== undefined || edits.end !== undefined || edits.mute)) throw new ApiError(400, 'Time and audio controls are only available for video and audio.');
  const crop = edits.crop;
  if (crop && (crop.x + crop.width > 1.000001 || crop.y + crop.height > 1.000001)) throw new ApiError(400, 'Keep the crop inside the source image.');
  if (crop && metadata.width && metadata.height && (crop.width * metadata.width < (asset.kind === 'video' ? 2 : 1) || crop.height * metadata.height < (asset.kind === 'video' ? 2 : 1))) throw new ApiError(400, 'The crop is too small. Make the selection a little larger.');
  if (asset.kind !== 'image') {
    const duration = metadata.duration;
    if (!duration || !Number.isFinite(duration)) throw new ApiError(400, 'Could not determine the duration of this file. Try another media file.');
    const start = edits.start ?? 0;
    const end = edits.end ?? duration;
    if (start >= duration || end > duration + 0.01 || end - start < 0.05) throw new ApiError(400, 'Choose an end time after the start and within the source duration (at least 0.05 seconds).');
  }
}

interface CommandOptions { signal?: AbortSignal; progress?: (seconds: number) => void; timeout?: number }
async function command(binary: string, args: string[], options: CommandOptions = {}) {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let progressBuffer = '';
    let timedOut = false;
    let spawnFailed = false;
    const stop = () => child.kill('SIGKILL');
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeout ?? 600_000);
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    child.stdout.on('data', (bytes: Buffer) => {
      const text = bytes.toString();
      stdout = (stdout + text).slice(-1_048_576);
      if (options.progress) {
        progressBuffer += text;
        const lines = progressBuffer.split('\n'); progressBuffer = lines.pop()!;
        for (const line of lines) if (line.startsWith('out_time_us=')) options.progress(Number(line.slice(12)) / 1_000_000);
      }
    });
    child.stderr.on('data', (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(-16384); });
    const clean = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); };
    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnFailed = true;
      clean();
      reject(error.code === 'ENOENT' ? new ApiError(503, 'Video and audio editing needs FFmpeg and ffprobe. Install FFmpeg, then try again (see the README).') : error);
    });
    child.on('close', code => {
      clean();
      if (spawnFailed) return;
      if (options.signal?.aborted) return reject(new ApiError(409, 'Preparation was interrupted. Your original is unchanged.'));
      if (timedOut) return reject(new ApiError(422, 'Preparation took too long. Choose a shorter clip or smaller output and try again.'));
      if (code !== 0) {
        // Decoder details can contain local paths. Keep them on the server.
        if (process.env.NODE_ENV !== 'test') console.error('Media processing failed:', stderr.slice(-1000));
        return reject(new ApiError(422, 'This file could not be processed. Try a smaller selection or another media format.'));
      }
      resolvePromise(stdout);
    });
  });
}

export async function inspectMedia(path: string, kind: StoredAsset['kind']): Promise<MediaMetadata> {
  if (kind === 'image') {
    try {
      const metadata = await sharp(path).metadata();
      const rotated = metadata.orientation && metadata.orientation >= 5;
      return { width: rotated ? metadata.height : metadata.width, height: rotated ? metadata.width : metadata.height, animated: (metadata.pages ?? 1) > 1 };
    } catch { throw new ApiError(422, 'This image could not be opened. Try another image format.'); }
  }
  const output = await command(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'stream=codec_type,width,height,duration,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation:format=duration', '-of', 'json', path], { timeout: 30_000 });
  const probe = JSON.parse(output);
  const streams = probe.streams ?? [];
  const video = streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
  const audio = streams.find((stream: { codec_type: string }) => stream.codec_type === 'audio');
  if ((kind === 'video' && !video) || (kind === 'audio' && !audio)) throw new ApiError(422, `This file does not contain a readable ${kind} track.`);
  const rawDuration = Number(probe.format?.duration ?? video?.duration ?? audio?.duration);
  const result: MediaMetadata = { duration: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : undefined, hasAudio: !!audio };
  if (video && kind === 'video') {
    const [numerator, denominator] = (video.sample_aspect_ratio || '1:1').split(':').map(Number);
    const pixelRatio = numerator > 0 && denominator > 0 ? numerator / denominator : 1;
    const rotation = Number(video.side_data_list?.find((entry: { rotation?: number }) => entry.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0);
    const rotated = Math.abs(rotation % 180) === 90;
    const displayWidth = Math.round(video.width * pixelRatio);
    result.width = rotated ? video.height : displayWidth;
    result.height = rotated ? displayWidth : video.height;
  }
  return result;
}

export class MediaService {
  private queue: { asset: StoredAsset; edits: AssetEdits; id: string }[] = [];
  private controllers = new Set<AbortController>();
  private active = 0;
  private closed = false;
  constructor(private store: Store) {}

  async inspect(asset: StoredAsset) {
    if (!asset.metadata) {
      asset.metadata = await inspectMedia(resolve(this.store.uploads, asset.filename), asset.kind);
      await this.store.save();
    }
    return asset.metadata;
  }

  async prepare(asset: StoredAsset, edits: AssetEdits) {
    if (asset.preparation && ['queued', 'processing'].includes(asset.preparation.status)) throw new ApiError(409, 'This asset is already being prepared.');
    if (this.queue.length >= 20) throw new ApiError(429, 'The editor queue is full. Wait for a preparation to finish.');
    await this.inspect(asset);
    if (!this.store.data.assets.includes(asset)) throw new ApiError(404, 'This asset was removed while opening the editor.');
    if (asset.preparation && ['queued', 'processing'].includes(asset.preparation.status)) throw new ApiError(409, 'This asset is already being prepared.');
    validateEdits(edits, asset);
    const id = randomUUID();
    asset.preparation = { id, status: 'queued', progress: 0 };
    await this.store.save();
    this.queue.push({ asset, edits, id });
    this.drain();
  }

  private drain() {
    while (!this.closed && this.active < 2 && this.queue.length) {
      const task = this.queue.shift()!;
      this.active++;
      void this.process(task).finally(() => { this.active--; this.drain(); });
    }
  }

  private async process({ asset, edits, id }: { asset: StoredAsset; edits: AssetEdits; id: string }) {
    const extension = asset.kind === 'image' ? 'png' : asset.kind === 'video' ? 'mp4' : 'wav';
    const filename = `${id}.${extension}`;
    const output = resolve(this.store.prepared, filename);
    const input = resolve(this.store.uploads, asset.filename);
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      asset.preparation = { id, status: 'processing', progress: 0 };
      await this.store.save();
      const metadata = asset.metadata!;
      const dimensions = preparedDimensions(metadata, edits, asset.kind);
      if (asset.kind === 'image') {
        let image = sharp(input).autoOrient();
        if (edits.crop) {
          const left = Math.floor(edits.crop.x * metadata.width!);
          const top = Math.floor(edits.crop.y * metadata.height!);
          image = image.extract({ left, top, width: Math.min(Math.floor(edits.crop.width * metadata.width!), metadata.width! - left), height: Math.min(Math.floor(edits.crop.height * metadata.height!), metadata.height! - top) });
        }
        await image.resize({ width: dimensions!.width, height: dimensions!.height, fit: 'inside', withoutEnlargement: true }).png().toFile(output);
      } else {
        const start = edits.start ?? 0;
        const duration = (edits.end ?? metadata.duration!) - start;
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-ss', String(start), '-i', input, '-t', String(duration)];
        if (asset.kind === 'video') {
          const filters = [`scale=${metadata.width}:${metadata.height}`, 'setsar=1'];
          if (edits.crop) {
            const { x, y, width, height } = edits.crop;
            const cropWidth = Math.max(2, Math.floor(width * metadata.width!));
            const cropHeight = Math.max(2, Math.floor(height * metadata.height!));
            filters.push(`crop=${cropWidth}:${cropHeight}:${Math.min(Math.floor(x * metadata.width!), metadata.width! - cropWidth)}:${Math.min(Math.floor(y * metadata.height!), metadata.height! - cropHeight)}:exact=1`);
          }
          filters.push(`scale=${dimensions!.width}:${dimensions!.height}:flags=lanczos`, 'setsar=1');
          args.push('-map', '0:v:0', '-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p');
          if (edits.mute || !metadata.hasAudio) args.push('-an');
          else args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k');
          args.push('-movflags', '+faststart');
        } else args.push('-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le');
        args.push('-map_metadata', '-1', '-progress', 'pipe:1', '-nostats', output);
        await command(process.env.FFMPEG_PATH || 'ffmpeg', args, { signal: controller.signal, progress: seconds => {
          if (asset.preparation?.id === id && Number.isFinite(seconds)) asset.preparation.progress = Math.min(0.98, Math.max(0, seconds / duration));
        } });
      }
      if (this.closed) throw new ApiError(409, 'Preparation was interrupted. Please save again.');
      const size = (await stat(output)).size;
      if (!size || size > MAX_REFERENCE_BYTES) throw new ApiError(413, 'The prepared input is larger than 25 MB. Shorten the selection or lower its maximum dimensions, then save again.');
      const outputMetadata = await inspectMedia(output, asset.kind);
      const prepared = { id, mime: asset.kind === 'image' ? 'image/png' : asset.kind === 'video' ? 'video/mp4' : 'audio/wav', size, url: `/api/assets/${asset.id}/prepared/${id}/content`, metadata: outputMetadata, edits, createdAt: new Date().toISOString() };
      asset.versions = [...(asset.versions ?? []), { ...prepared, filename }];
      asset.prepared = prepared;
      asset.preparation = { id, status: 'completed', progress: 1 };
    } catch (error) {
      await unlink(output).catch(() => {});
      asset.preparation = { id, status: 'failed', progress: 0, error: error instanceof ApiError ? error.message : 'Could not prepare this asset. Your original and previous input are unchanged. Try another selection.' };
    } finally {
      this.controllers.delete(controller);
      await this.store.save().catch(() => {});
    }
  }

  close() { this.closed = true; this.controllers.forEach(controller => controller.abort()); this.queue = []; }
}
