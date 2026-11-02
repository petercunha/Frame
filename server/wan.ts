import { z } from 'zod';
import type { VideoModel, WanAccountBalance } from '../shared/types';
import { ApiError, type UpstreamJob } from './openrouter';

export const wanModel: VideoModel = {
  id: 'wan3.0-video', name: 'Wan 3.0',
  description: 'Create video from text, first/last frames, or image, video and audio references through Wan API.',
  supported_durations: Array.from({ length: 29 }, (_, index) => index + 2),
  supported_resolutions: ['480p', '720p', '1080p'],
  supported_aspect_ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'],
  supported_frame_images: ['first_frame', 'last_frame'], supported_sizes: null,
  generate_audio: true, seed: true, pricing_skus: {}, allowed_passthrough_parameters: [],
};
const taskSchema = z.object({
  task_info: z.object({
    id: z.string().min(1), status: z.enum(['pending', 'processing', 'completed', 'failed']),
    error: z.unknown().optional(),
  }),
  videos: z.array(z.url()).optional(), error: z.unknown().optional(),
  usage: z.object({ cost: z.number().nonnegative().optional() }).optional(),
});
const endpoint = '/wan/v1/wan3.0-video/generation';
const balanceSchema = z.object({ object: z.literal('balance'), currency: z.literal('USD'), balance: z.number(), key_remaining: z.number().nullable() });

export class Wan {
  constructor(private readonly base = 'https://api.wanapi.app', private readonly fetcher: typeof fetch = fetch) {}
  private async request(path: string, key: string, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        ...init, headers: { ...init.headers, Authorization: `Bearer ${key}` }, signal: AbortSignal.any([AbortSignal.timeout(90_000), ...(init.signal ? [init.signal] : [])]),
      });
    } catch {
      throw new ApiError(502, init.method === 'POST'
        ? 'Wan API submission could not be confirmed. Check your Wan task history before submitting again to avoid a duplicate charge.'
        : 'Could not reach Wan API. Check your connection and try again.');
    }
    if (!response.ok) {
      let message = `Wan API returned ${response.status}.`;
      try {
        const body = await response.json();
        message = body.error?.message || (typeof body.error === 'string' ? body.error : body.message) || message;
      } catch { /* non-JSON upstream */ }
      throw new ApiError(response.status, String(message).replaceAll(key, '[redacted]'));
    }
    return response;
  }
  private async task(response: Response): Promise<UpstreamJob> {
    const parsed = taskSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ApiError(502, 'Wan API returned an invalid task receipt. Check your Wan task history before submitting again.');
    const task = parsed.data;
    return { id: task.task_info.id, status: task.task_info.status === 'processing' ? 'in_progress' : task.task_info.status, urls: task.videos, error: task.error ?? task.task_info.error, usage: task.usage };
  }
  async models() { return [wanModel]; }
  async validateKey(key: string) { await this.request('/v1/balance', key); }
  async balance(key: string): Promise<WanAccountBalance> {
    const response = await this.request('/v1/balance', key, { signal: AbortSignal.timeout(15_000) });
    const parsed = balanceSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ApiError(502, 'Wan API returned an invalid balance response. Please refresh to try again.');
    return { currency: parsed.data.currency, balance: parsed.data.balance, keyRemaining: parsed.data.key_remaining, checkedAt: new Date().toISOString() };
  }
  async submit(key: string, body: Record<string, unknown>) {
    return this.task(await this.request(endpoint, key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  }
  async poll(key: string, id: string, signal?: AbortSignal) { return this.task(await this.request(`${endpoint}/${encodeURIComponent(id)}`, key, { signal })); }
  async content(key: string, id: string, index: number, range?: string, signal?: AbortSignal) {
    const task = await this.poll(key, id, signal);
    const url = task.urls?.[index];
    if (task.status !== 'completed' || !url) throw new ApiError(502, 'Wan API no longer has this video available.');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new ApiError(502, 'Wan API returned an invalid video URL.');
    let response: Response;
    try {
      // Signed CDN URLs need no API key. Never forward provider credentials.
      response = await this.fetcher(url, { headers: range ? { Range: range } : {}, signal: AbortSignal.any([AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]) });
    } catch { throw new ApiError(502, 'Could not download the existing Wan video. Try downloading it again.'); }
    if (!response.ok) throw new ApiError(response.status === 416 ? 416 : 502, 'Wan video download failed. The output may have expired; try downloading it again.');
    return response;
  }
}
