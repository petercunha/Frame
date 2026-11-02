import { z } from 'zod';
import type { VideoModel, JobStatus } from '../shared/types';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const modelSchema = z.object({
  id: z.string(), name: z.string(), description: z.string().default(''),
  supported_durations: z.array(z.number()).nullable().default(null),
  supported_resolutions: z.array(z.string()).nullable().default(null),
  supported_aspect_ratios: z.array(z.string()).nullable().default(null),
  supported_sizes: z.array(z.string()).nullable().default(null),
  supported_frame_images: z.array(z.string()).nullable().default(null),
  generate_audio: z.boolean().nullable().default(null), seed: z.boolean().nullable().default(null),
  upscale_factor: z.object({ min: z.number(), max: z.number() }).nullable().optional(),
  creativity: z.array(z.number()).nullable().optional(),
  pricing_skus: z.record(z.string(), z.string()).default({}),
  allowed_passthrough_parameters: z.array(z.string()).default([]),
});
const jobSchema = z.object({
  id: z.string(), status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'expired']),
  unsigned_urls: z.array(z.string()).optional(), urls: z.array(z.string()).optional(),
  usage: z.object({ cost: z.number().optional() }).optional(), error: z.unknown().optional(),
});
export type UpstreamJob = z.infer<typeof jobSchema> & { status: JobStatus };

export class OpenRouter {
  private cached?: { models: VideoModel[]; at: number };
  constructor(private readonly base = 'https://openrouter.ai/api/v1', private readonly fetcher: typeof fetch = fetch) {}
  async request(path: string, key?: string, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        ...init,
        headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'X-OpenRouter-Title': 'Frame Video Studio', ...init.headers },
        signal: AbortSignal.timeout(90_000),
      });
    } catch { throw new ApiError(502, 'Could not reach OpenRouter. Check your connection and try again.'); }
    if (!response.ok) {
      let message = `OpenRouter returned ${response.status}.`;
      try { const body = await response.json(); message = body.error?.message || message; } catch { /* non-JSON upstream */ }
      throw new ApiError(response.status, key ? String(message).replaceAll(key, '[redacted]') : String(message));
    }
    return response;
  }
  async models() {
    if (this.cached && Date.now() - this.cached.at < 300_000) return this.cached.models;
    try {
      const response = await this.request('/videos/models');
      const parsed = z.object({ data: z.array(modelSchema) }).parse(await response.json());
      this.cached = { models: parsed.data, at: Date.now() };
    } catch (error) { if (!this.cached) throw error; }
    return this.cached!.models;
  }
  async submit(key: string, body: Record<string, unknown>) {
    const response = await this.request('/videos', key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return jobSchema.parse(await response.json());
  }
  async poll(key: string, id: string) {
    return jobSchema.parse(await (await this.request(`/videos/${encodeURIComponent(id)}`, key)).json());
  }
  async validateKey(key: string) { await this.request('/key', key); }
  content(key: string, id: string, index: number, range?: string) {
    return this.request(`/videos/${encodeURIComponent(id)}/content?index=${index}`, key, { headers: range ? { Range: range } : {} });
  }
}
